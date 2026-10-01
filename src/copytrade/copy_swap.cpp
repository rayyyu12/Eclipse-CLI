#include "eclipse/copytrade/copy_swap.hpp"

#include <cmath>
#include <iomanip>
#include <limits>
#include <sstream>

#include "eclipse/cli/settings.hpp"
#include "eclipse/copytrade/copy_trade_logger.hpp"
#include "eclipse/fees/jito.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/solana/transaction.hpp"
#include "eclipse/swaps/blockhash_manager.hpp"
#include "eclipse/swaps/pump_swap.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace eclipse::copytrade {
namespace {

std::uint64_t to_u64(double value) {
  if (!(value > 0.0)) return 0;  // also catches NaN
  if (value >= static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  return static_cast<std::uint64_t>(value);
}

std::string fixed(double value, int places) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(places) << value;
  return out.str();
}

double lamports_to_sol(std::uint64_t lamports) {
  return static_cast<double>(lamports) /
         static_cast<double>(solana::kLamportsPerSol);
}

/// `fixedPriorityFee || DEFAULT_PRIORITY_FEE`: the copy path never asks the
/// RPC for an estimate, whatever the automatic-fee setting says.
std::uint64_t copy_priority_fee(const cli::FeeSettings& fees) {
  const std::uint64_t fixed_fee = fees.fixed_priority_fee.value_or(0);
  return fixed_fee > 0 ? fixed_fee : kCopyDefaultPriorityFee;
}

/// Compute budget first, then the tip, as both TypeScript copy swaps ordered
/// them.
std::vector<solana::Instruction> preamble(const Pubkey& payer,
                                          std::uint64_t priority_fee,
                                          std::uint64_t tip_lamports) {
  return {
      solana::compute_budget::set_compute_unit_limit(kCopyComputeUnitLimit),
      solana::compute_budget::set_compute_unit_price(priority_fee),
      fees::build_tip_instruction(payer, tip_lamports),
  };
}

/// The shared tail: sign, hand to the block engine, report. The signature is
/// the first 64 bytes of what was signed, so it is known before the send
/// returns and does not depend on what the block engine echoes back.
swaps::SwapResult sign_and_send(const Keypair& wallet,
                                const std::string& blockhash,
                                std::vector<solana::Instruction> instructions,
                                swaps::SwapResult result,
                                swaps::StageTimer& timer) {
  solana::Transaction transaction;
  transaction.set_fee_payer(wallet.pubkey());
  transaction.set_recent_blockhash(blockhash);
  transaction.add(std::move(instructions));

  std::vector<std::uint8_t> wire;
  try {
    wire = transaction.sign_and_serialize({&wallet});
  } catch (const std::exception& error) {
    return swaps::SwapResult::failure(std::string("could not sign: ") +
                                      error.what());
  }
  const std::string signature = solana::Transaction::signature_to_string(wire);
  timer.mark("Transaction build/sign");

  const auto accepted = fees::send_bundle(wire, fees::JitoSendOptions{});
  timer.mark("Send");

  result.signature = signature;
  if (!accepted.has_value()) {
    result.success = false;
    result.error = "the Jito block engine did not accept the transaction";
    return result;
  }

  result.success = true;
  return result;
}

std::optional<net::BlockhashInfo> cached_blockhash(swaps::StageTimer& timer) {
  auto blockhash = swaps::BlockhashManager::instance().get();
  timer.mark("Blockhash fetch");
  return blockhash;
}

/// Bonding curve PDA, the curve's token account and the wallet's, all derived
/// locally. The curve is derived from the mint rather than taken from the
/// followed instruction, as the TypeScript build did.
std::optional<swaps::PumpTradeAccounts> derive_pump_accounts(
    const Keypair& wallet, const Pubkey& mint) {
  const auto curve = pools::derive_bonding_curve(mint);
  if (!curve.has_value()) return std::nullopt;

  swaps::PumpTradeAccounts accounts;
  accounts.mint = mint;
  accounts.bonding_curve = *curve;
  accounts.associated_bonding_curve =
      Pubkey::associated_token_address(*curve, mint);
  accounts.user = wallet.pubkey();
  accounts.user_token_account =
      Pubkey::associated_token_address(wallet.pubkey(), mint);
  return accounts;
}

/// The one round trip on the pump.fun path: the curve's live reserves.
std::optional<pools::BondingCurveState> read_live_curve(
    net::RpcClient& client, const Pubkey& curve, std::string& error) {
  auto state = pools::fetch_bonding_curve_at(client, curve);
  if (!state.has_value()) {
    error = "bonding curve account not found: " + curve.to_base58();
    return std::nullopt;
  }
  if (state->complete) {
    error = "token has migrated from pump.fun";
    return std::nullopt;
  }
  return state;
}

}  // namespace

// --- Sizing ------------------------------------------------------------------------

PumpBuyQuote quote_pump_copy_buy(const pools::BondingCurveState& curve,
                                 std::uint64_t lamports,
                                 double slippage_percent) {
  return {swaps::curve_buy_output(curve, lamports),
          swaps::apply_slippage_ceiling(lamports, slippage_percent)};
}

PumpSellQuote quote_pump_copy_sell(const pools::BondingCurveState& curve,
                                   std::uint64_t token_amount,
                                   double slippage_percent) {
  const std::uint64_t expected = swaps::curve_sell_output(curve, token_amount);
  return {expected, swaps::apply_slippage(expected, slippage_percent)};
}

std::optional<RaydiumCopyQuote> quote_raydium_copy(
    std::uint64_t amount_in, const PoolBalances& pool_balances,
    int token_decimals, double slippage_percent) {
  const double coin = pool_balances.coin.pre;
  const double pc = pool_balances.pc.pre;
  if (!(coin > 0.0)) return std::nullopt;

  const double decimal_adjustment = std::pow(10.0, 9 - token_decimals);
  const double raw =
      (static_cast<double>(amount_in) * pc) / (coin * decimal_adjustment);
  const double expected = std::floor(raw * 1e-4);

  const double tolerance = slippage_percent / 100.0;
  const double minimum =
      std::floor(expected * (1.0 - tolerance - kRaydiumPoolFeeBuffer));

  return RaydiumCopyQuote{to_u64(expected), to_u64(minimum)};
}

// --- pump.fun ------------------------------------------------------------------------

swaps::SwapResult copy_pump_buy(net::RpcClient& client, const Keypair& wallet,
                                const PumpSwapData& swap,
                                std::uint64_t amount_in_lamports,
                                double slippage_percent,
                                swaps::StageTimer& timer) {
  auto& feed = CopyTradeLogger::instance();
  const auto settings = cli::SettingsManager::instance().get();

  const auto accounts = derive_pump_accounts(wallet, swap.token_address);
  if (!accounts.has_value()) {
    return swaps::SwapResult::failure("could not derive the bonding curve");
  }
  timer.mark("ATA derivation");

  std::string error;
  const auto curve = read_live_curve(client, accounts->bonding_curve, error);
  timer.mark("Bonding curve fetch");
  if (!curve.has_value()) return swaps::SwapResult::failure(error);

  const auto blockhash = cached_blockhash(timer);
  if (!blockhash.has_value()) {
    return swaps::SwapResult::failure("could not get a recent blockhash");
  }

  const std::uint64_t priority_fee = copy_priority_fee(settings.fees);
  const std::uint64_t tip = fees::resolve_tip_lamports(settings.fees);
  timer.mark("Jito tip");

  const PumpBuyQuote quote =
      quote_pump_copy_buy(*curve, amount_in_lamports, slippage_percent);
  if (quote.expected_tokens == 0) {
    return swaps::SwapResult::failure("curve cannot fill an order that size");
  }

  feed.add(CopyLogType::Info, "pump", "Swap parameters",
           {{"amountInSol", fixed(lamports_to_sol(amount_in_lamports), 4)},
            {"expectedOutput", std::to_string(quote.expected_tokens)},
            {"maxCostSol", fixed(lamports_to_sol(quote.max_sol_cost), 4)},
            {"slippage", fixed(slippage_percent, 2) + "%"}});

  // The buy requests the full quoted amount and lets slippage widen the SOL
  // ceiling, rather than shaving the token amount.
  auto instructions = preamble(wallet.pubkey(), priority_fee, tip);
  instructions.push_back(solana::associated_token::create_idempotent(
      wallet.pubkey(), accounts->user_token_account, wallet.pubkey(),
      swap.token_address));
  instructions.push_back(swaps::build_pump_buy_instruction(
      *accounts, quote.expected_tokens, quote.max_sol_cost));
  timer.mark("Instruction building");

  swaps::SwapResult result;
  result.amount_in = amount_in_lamports;
  result.expected_out = quote.expected_tokens;
  result.min_out = quote.expected_tokens;
  result.priority_fee_micro_lamports = priority_fee;
  result.jito_tip_lamports = tip;

  return sign_and_send(wallet, blockhash->blockhash, std::move(instructions),
                       std::move(result), timer);
}

swaps::SwapResult copy_pump_sell(net::RpcClient& client, const Keypair& wallet,
                                 const PumpSwapData& swap,
                                 std::uint64_t token_amount,
                                 double slippage_percent,
                                 swaps::StageTimer& timer) {
  auto& feed = CopyTradeLogger::instance();
  const auto settings = cli::SettingsManager::instance().get();

  const auto accounts = derive_pump_accounts(wallet, swap.token_address);
  if (!accounts.has_value()) {
    return swaps::SwapResult::failure("could not derive the bonding curve");
  }
  timer.mark("ATA derivation");

  std::string error;
  const auto curve = read_live_curve(client, accounts->bonding_curve, error);
  timer.mark("Bonding curve fetch");
  if (!curve.has_value()) return swaps::SwapResult::failure(error);

  const auto blockhash = cached_blockhash(timer);
  if (!blockhash.has_value()) {
    return swaps::SwapResult::failure("could not get a recent blockhash");
  }

  const std::uint64_t priority_fee = copy_priority_fee(settings.fees);
  const std::uint64_t tip = fees::resolve_tip_lamports(settings.fees);
  timer.mark("Jito tip");

  const PumpSellQuote quote =
      quote_pump_copy_sell(*curve, token_amount, slippage_percent);

  feed.add(CopyLogType::Info, "pump", "Sell parameters",
           {{"amountInTokens", std::to_string(token_amount)},
            {"expectedOutputSol", fixed(lamports_to_sol(quote.expected_sol), 4)},
            {"minOutputSol", fixed(lamports_to_sol(quote.min_sol_output), 4)},
            {"slippage", fixed(slippage_percent, 2) + "%"}});

  // No account creation on a sell: the wallet's token account must already
  // exist to hold what is being sold.
  auto instructions = preamble(wallet.pubkey(), priority_fee, tip);
  instructions.push_back(swaps::build_pump_sell_instruction(
      *accounts, token_amount, quote.min_sol_output));
  timer.mark("Instruction building");

  swaps::SwapResult result;
  result.amount_in = token_amount;
  result.expected_out = quote.expected_sol;
  result.min_out = quote.min_sol_output;
  result.priority_fee_micro_lamports = priority_fee;
  result.jito_tip_lamports = tip;

  return sign_and_send(wallet, blockhash->blockhash, std::move(instructions),
                       std::move(result), timer);
}

// --- Raydium ------------------------------------------------------------------------

swaps::SwapResult copy_raydium_swap(const Keypair& wallet,
                                    const RaydiumSwapData& swap,
                                    std::uint64_t amount_in,
                                    double slippage_percent,
                                    swaps::StageTimer& timer) {
  auto& feed = CopyTradeLogger::instance();
  const auto settings = cli::SettingsManager::instance().get();

  const auto in_mint = Pubkey::try_parse(swap.token_in_mint);
  const auto out_mint = Pubkey::try_parse(swap.token_out_mint);
  if (!in_mint.has_value() || !out_mint.has_value()) {
    return swaps::SwapResult::failure("swap has no input or output mint");
  }

  const auto blockhash = cached_blockhash(timer);
  if (!blockhash.has_value()) {
    return swaps::SwapResult::failure("could not get a recent blockhash");
  }

  // The TypeScript build derived these three with Promise.all. Derivation is
  // local hashing with no I/O, so they are simply done in turn.
  const Pubkey& owner = wallet.pubkey();
  const Pubkey& wsol_mint = solana::native_mint();
  const Pubkey user_wsol = Pubkey::associated_token_address(owner, wsol_mint);
  const Pubkey user_in = Pubkey::associated_token_address(owner, *in_mint);
  const Pubkey user_out = Pubkey::associated_token_address(owner, *out_mint);
  timer.mark("ATA derivation");

  const std::uint64_t priority_fee = copy_priority_fee(settings.fees);
  const std::uint64_t tip = fees::resolve_tip_lamports(settings.fees);
  timer.mark("Jito tip");

  // As in raydiumCopySwap.ts: 9 on a buy, 6 on a sell.
  const int token_decimals = swap.is_buy ? 9 : 6;
  const auto quote = quote_raydium_copy(amount_in, swap.pool_balances,
                                        token_decimals, slippage_percent);
  if (!quote.has_value()) {
    return swaps::SwapResult::failure("missing pool balance information");
  }

  feed.add(CopyLogType::Info, "raydium", "Swap parameters",
           {{"inputAmount", swap.is_buy ? fixed(lamports_to_sol(amount_in), 9) +
                                              " SOL"
                                        : std::to_string(amount_in)},
            {"expectedOutput", std::to_string(quote->expected_output)},
            {"minimumOutput", std::to_string(quote->min_amount_out)},
            {"slippage", fixed(slippage_percent, 2) + "%"}});

  auto instructions = preamble(owner, priority_fee, tip);

  // Idempotent creates for the input, output and WSOL accounts, in that
  // order. On a buy the input is WSOL, so that create appears twice; it is
  // idempotent, and the order is kept as the TypeScript build had it.
  instructions.push_back(solana::associated_token::create_idempotent(
      owner, user_in, owner, *in_mint));
  instructions.push_back(solana::associated_token::create_idempotent(
      owner, user_out, owner, *out_mint));
  instructions.push_back(solana::associated_token::create_idempotent(
      owner, user_wsol, owner, wsol_mint));

  if (swap.is_buy) {
    // Wrap: move the lamports into the WSOL account and resync its balance.
    instructions.push_back(
        solana::system_program::transfer(owner, user_wsol, amount_in));
    instructions.push_back(solana::token_program::sync_native(user_wsol));
  }

  const Pubkey& source = swap.is_buy ? user_wsol : user_in;
  const Pubkey& destination = swap.is_buy ? user_out : user_wsol;
  instructions.push_back(swaps::build_raydium_swap(
      owner, source, destination, swap.pool, amount_in, quote->min_amount_out));

  if (!swap.is_buy) {
    // Closing the WSOL account unwraps the proceeds.
    instructions.push_back(
        solana::token_program::close_account(user_wsol, owner, owner));
  }
  timer.mark("Instruction building");

  swaps::SwapResult result;
  result.amount_in = amount_in;
  result.expected_out = quote->expected_output;
  result.min_out = quote->min_amount_out;
  result.priority_fee_micro_lamports = priority_fee;
  result.jito_tip_lamports = tip;

  return sign_and_send(wallet, blockhash->blockhash, std::move(instructions),
                       std::move(result), timer);
}

}  // namespace eclipse::copytrade
