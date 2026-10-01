#include "eclipse/swaps/pump_swap.hpp"

#include <algorithm>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/fees/jito.hpp"
#include "eclipse/fees/priority_fees.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/solana/transaction.hpp"
#include "eclipse/swaps/blockhash_manager.hpp"
#include "eclipse/swaps/constants.hpp"
#include "eclipse/swaps/regular_swap.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace eclipse::swaps {
namespace {

using u128 = unsigned __int128;

/// Pump.fun's associated bonding curve is the curve PDA's token account for
/// the mint, so it derives the same way any ATA does.
Pubkey associated_bonding_curve(const Pubkey& curve, const Pubkey& mint) {
  return Pubkey::associated_token_address(curve, mint);
}

/// Anchor's instruction data: an 8-byte discriminator then the arguments.
std::vector<std::uint8_t> build_pump_data(const std::uint8_t (&discriminator)[8],
                                          std::uint64_t amount,
                                          std::uint64_t sol_limit) {
  std::vector<std::uint8_t> data;
  data.insert(data.end(), std::begin(discriminator), std::end(discriminator));
  solana::put_u64(data, amount);
  solana::put_u64(data, sol_limit);
  return data;
}

/// The account order both instructions share, up to and including the
/// system program. The four slots after it differ; see the builders.
std::vector<solana::AccountMeta> leading_accounts(
    const PumpTradeAccounts& accounts) {
  using solana::AccountMeta;
  return {
      AccountMeta::readonly(pump_fun_global()),
      AccountMeta::writable(pump_fun_fee_recipient()),
      AccountMeta::readonly(accounts.mint),
      AccountMeta::writable(accounts.bonding_curve),
      AccountMeta::writable(accounts.associated_bonding_curve),
      AccountMeta::writable(accounts.user_token_account),
      AccountMeta::signer(accounts.user),
      AccountMeta::readonly(solana::system_program_id()),
  };
}

struct PumpContext {
  pools::BondingCurveState curve;
  Pubkey curve_ata;
  Pubkey user_ata;

  PumpTradeAccounts trade_accounts(const Pubkey& mint,
                                   const Pubkey& user) const {
    return {mint, curve.address, curve_ata, user, user_ata};
  }
};

std::optional<PumpContext> load_context(net::RpcClient& client,
                                        const Keypair& wallet,
                                        const Pubkey& mint) {
  auto curve = pools::fetch_bonding_curve(client, mint);
  if (!curve.has_value()) return std::nullopt;

  PumpContext context;
  context.curve = *curve;
  context.curve_ata = associated_bonding_curve(curve->address, mint);
  context.user_ata = Pubkey::associated_token_address(wallet.pubkey(), mint);
  return context;
}

/// Shared tail: compute budget, optional tip, sign, send, confirm.
SwapResult submit(net::RpcClient& client, const Keypair& wallet,
                  std::vector<solana::Instruction> instructions,
                  const SwapOptions& options, std::uint64_t amount_in,
                  std::uint64_t expected_out, std::uint64_t min_out,
                  std::chrono::steady_clock::time_point started) {
  const auto settings = cli::SettingsManager::instance().get();

  auto blockhash = BlockhashManager::instance().get();
  if (!blockhash.has_value()) {
    return SwapResult::failure("could not get a recent blockhash");
  }

  solana::Transaction probe;
  probe.set_fee_payer(wallet.pubkey());
  probe.set_recent_blockhash(blockhash->blockhash);
  probe.add(instructions);

  const std::uint64_t priority_fee = fees::resolve_priority_fee(
      client, settings.fees, probe.serialize_unsigned());

  solana::Transaction transaction;
  transaction.set_fee_payer(wallet.pubkey());
  transaction.set_recent_blockhash(blockhash->blockhash);
  transaction.add(
      solana::compute_budget::set_compute_unit_limit(kSwapComputeUnitLimit));
  transaction.add(solana::compute_budget::set_compute_unit_price(priority_fee));
  transaction.add(std::move(instructions));

  std::uint64_t tip = 0;
  if (options.use_jito) {
    tip = fees::resolve_tip_lamports(settings.fees);
    transaction.add(fees::build_tip_instruction(wallet.pubkey(), tip));
  }

  SwapResult result;
  result.amount_in = amount_in;
  result.expected_out = expected_out;
  result.min_out = min_out;
  result.priority_fee_micro_lamports = priority_fee;
  result.jito_tip_lamports = tip;

  std::vector<std::uint8_t> wire;
  try {
    wire = transaction.sign_and_serialize({&wallet});
  } catch (const std::exception& error) {
    return SwapResult::failure(std::string("could not sign: ") + error.what());
  }

  auto signature = options.use_jito ? fees::send_bundle(wire)
                                    : client.send_transaction(
                                          wire, options.skip_preflight);
  if (!signature.has_value() && options.use_jito) {
    signature = client.send_transaction(wire, options.skip_preflight);
  }
  if (!signature.has_value()) {
    return SwapResult::failure(client.last_error().empty()
                                   ? "transaction was not accepted"
                                   : client.last_error());
  }

  result.signature = *signature;
  result.success = true;

  if (options.wait_for_confirmation) {
    result.success = await_confirmation(client, *signature,
                                        options.confirmation_timeout);
    if (!result.success) result.error = "not confirmed before the timeout";
  }

  result.elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started);
  return result;
}

}  // namespace

solana::Instruction build_pump_buy_instruction(const PumpTradeAccounts& accounts,
                                               std::uint64_t token_amount,
                                               std::uint64_t max_sol_cost) {
  using solana::AccountMeta;

  solana::Instruction buy;
  buy.program_id = pump_fun_program_id();
  buy.accounts = leading_accounts(accounts);
  buy.accounts.push_back(AccountMeta::readonly(solana::token_program_id()));
  buy.accounts.push_back(AccountMeta::readonly(solana::rent_sysvar_id()));
  buy.accounts.push_back(AccountMeta::readonly(pump_fun_event_authority()));
  buy.accounts.push_back(AccountMeta::readonly(pump_fun_program_id()));
  buy.data = build_pump_data(kPumpBuyDiscriminator, token_amount, max_sol_cost);
  return buy;
}

solana::Instruction build_pump_sell_instruction(
    const PumpTradeAccounts& accounts, std::uint64_t token_amount,
    std::uint64_t min_sol_output) {
  using solana::AccountMeta;

  solana::Instruction sell;
  sell.program_id = pump_fun_program_id();
  sell.accounts = leading_accounts(accounts);
  sell.accounts.push_back(
      AccountMeta::readonly(solana::associated_token_program_id()));
  sell.accounts.push_back(AccountMeta::readonly(solana::token_program_id()));
  sell.accounts.push_back(AccountMeta::readonly(pump_fun_event_authority()));
  sell.accounts.push_back(AccountMeta::readonly(pump_fun_program_id()));
  sell.data =
      build_pump_data(kPumpSellDiscriminator, token_amount, min_sol_output);
  return sell;
}

std::uint64_t curve_buy_output(const pools::BondingCurveState& curve,
                               std::uint64_t sol_in) {
  if (sol_in == 0 || curve.virtual_sol_reserves == 0 ||
      curve.virtual_token_reserves == 0) {
    return 0;
  }

  const u128 k = static_cast<u128>(curve.virtual_sol_reserves) *
                 curve.virtual_token_reserves;
  const u128 new_sol = static_cast<u128>(curve.virtual_sol_reserves) + sol_in;

  // Held at one unit for the same reason as the AMM quote: an input large
  // enough to floor the division must not quote the whole reserve.
  const u128 new_tokens = std::max<u128>(k / new_sol, 1);

  if (new_tokens >= curve.virtual_token_reserves) return 0;
  const auto out =
      static_cast<std::uint64_t>(curve.virtual_token_reserves - new_tokens);

  // The curve cannot pay out more than it actually holds, however favourable
  // the virtual reserves make the price look.
  return std::min(out, curve.real_token_reserves);
}

std::uint64_t curve_sell_output(const pools::BondingCurveState& curve,
                                std::uint64_t tokens_in) {
  if (tokens_in == 0 || curve.virtual_sol_reserves == 0 ||
      curve.virtual_token_reserves == 0) {
    return 0;
  }

  const u128 k = static_cast<u128>(curve.virtual_sol_reserves) *
                 curve.virtual_token_reserves;
  const u128 new_tokens =
      static_cast<u128>(curve.virtual_token_reserves) + tokens_in;
  const u128 new_sol = k / new_tokens;

  if (new_sol >= curve.virtual_sol_reserves) return 0;
  const auto out =
      static_cast<std::uint64_t>(curve.virtual_sol_reserves - new_sol);

  return std::min(out, curve.real_sol_reserves);
}

SwapResult pump_buy(net::RpcClient& client, const Keypair& wallet,
                    const Pubkey& token_mint, std::uint64_t sol_lamports,
                    const SwapOptions& options) {
  const auto started = std::chrono::steady_clock::now();

  auto context = load_context(client, wallet, token_mint);
  if (!context.has_value()) {
    return SwapResult::failure("no pump.fun bonding curve for this token");
  }
  if (context->curve.complete) {
    return SwapResult::failure(
        "bonding curve has completed; this token trades on Raydium");
  }

  const std::uint64_t expected = curve_buy_output(context->curve, sol_lamports);
  if (expected == 0) {
    return SwapResult::failure("curve cannot fill an order that size");
  }
  const std::uint64_t min_out =
      apply_slippage(expected, options.slippage_percent);

  Logger::instance().info(
      "PumpSwap", "Buying " + token_mint.to_base58() + " on the curve");

  std::vector<solana::Instruction> instructions;
  instructions.push_back(solana::associated_token::create_idempotent(
      wallet.pubkey(), wallet.pubkey(), token_mint));

  // Buy takes the token amount and a maximum SOL cost, so slippage widens the
  // cost ceiling rather than narrowing the output.
  const std::uint64_t max_sol_cost =
      apply_slippage_ceiling(sol_lamports, options.slippage_percent);

  instructions.push_back(build_pump_buy_instruction(
      context->trade_accounts(token_mint, wallet.pubkey()), min_out,
      max_sol_cost));

  return submit(client, wallet, std::move(instructions), options, sol_lamports,
                expected, min_out, started);
}

SwapResult pump_sell(net::RpcClient& client, const Keypair& wallet,
                     const Pubkey& token_mint, std::uint64_t token_amount,
                     const SwapOptions& options) {
  const auto started = std::chrono::steady_clock::now();

  auto context = load_context(client, wallet, token_mint);
  if (!context.has_value()) {
    return SwapResult::failure("no pump.fun bonding curve for this token");
  }
  if (context->curve.complete) {
    return SwapResult::failure(
        "bonding curve has completed; this token trades on Raydium");
  }

  const std::uint64_t expected =
      curve_sell_output(context->curve, token_amount);
  if (expected == 0) {
    return SwapResult::failure("curve has no SOL left to pay out");
  }
  const std::uint64_t min_out =
      apply_slippage(expected, options.slippage_percent);

  Logger::instance().info(
      "PumpSwap", "Selling " + token_mint.to_base58() + " into the curve");

  return submit(client, wallet,
                {build_pump_sell_instruction(
                    context->trade_accounts(token_mint, wallet.pubkey()),
                    token_amount, min_out)},
                options, token_amount, expected, min_out, started);
}

}  // namespace eclipse::swaps
