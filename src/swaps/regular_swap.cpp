#include "eclipse/swaps/regular_swap.hpp"

#include <thread>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/fees/jito.hpp"
#include "eclipse/fees/priority_fees.hpp"
#include "eclipse/pools/pool_discovery.hpp"
#include "eclipse/pools/pool_selector.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/solana/transaction.hpp"
#include "eclipse/swaps/blockhash_manager.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace eclipse::swaps {
namespace {

/// Rent for a 165-byte token account. Hardcoded rather than fetched: the
/// value has not moved since genesis and the swap path is latency-sensitive.
constexpr std::uint64_t kTokenAccountRent = 2039280;

struct PreparedSwap {
  pools::PoolAccounts pool;
  std::uint64_t expected_out = 0;
  std::uint64_t min_out = 0;
  bool token_is_base = false;
};

/// Works out which side of the pool the token sits on and quotes the trade in
/// that direction.
std::optional<PreparedSwap> prepare(net::RpcClient& client,
                                    const Pubkey& token_mint,
                                    std::uint64_t amount_in,
                                    bool buying, double slippage) {
  auto pool = pools::discover_pool(client, solana::native_mint(), token_mint);
  if (!pool.has_value()) return std::nullopt;

  PreparedSwap prepared;
  prepared.pool = *pool;
  prepared.token_is_base = pool->base_mint == token_mint;

  // On a buy the input is SOL, so the input reserve is whichever vault holds
  // the native mint; on a sell it is the other way round.
  const bool input_is_base = buying ? !prepared.token_is_base
                                    : prepared.token_is_base;

  auto base_balance =
      client.get_token_account_balance(pool->pool_coin_token_account);
  auto quote_balance =
      client.get_token_account_balance(pool->pool_pc_token_account);
  if (!base_balance.has_value() || !quote_balance.has_value()) {
    return std::nullopt;
  }

  const auto to_u64 = [](const std::string& text) -> std::uint64_t {
    auto parsed = pools::parse_amount(text, 0);
    return parsed.value_or(0);
  };

  const std::uint64_t base_reserve = to_u64(base_balance->amount);
  const std::uint64_t quote_reserve = to_u64(quote_balance->amount);

  prepared.expected_out = pools::constant_product_output(
      amount_in, input_is_base ? base_reserve : quote_reserve,
      input_is_base ? quote_reserve : base_reserve);

  if (prepared.expected_out == 0) return std::nullopt;

  prepared.min_out = apply_slippage(prepared.expected_out, slippage);
  return prepared;
}

/// Adds the compute budget preamble and, when enabled, the Jito tip, then
/// signs and submits.
SwapResult finalize(net::RpcClient& client, const Keypair& wallet,
                    solana::Transaction& transaction,
                    const std::vector<const Keypair*>& signers,
                    const SwapOptions& options, PreparedSwap prepared,
                    std::uint64_t amount_in,
                    std::chrono::steady_clock::time_point started) {
  const auto settings = cli::SettingsManager::instance().get();

  auto blockhash = BlockhashManager::instance().get();
  if (!blockhash.has_value()) {
    return SwapResult::failure("could not get a recent blockhash");
  }
  transaction.set_recent_blockhash(blockhash->blockhash);

  // Estimating needs a serialised transaction, so this happens after the
  // instructions are in place but before the real signature.
  const auto unsigned_wire = transaction.serialize_unsigned();
  const std::uint64_t priority_fee =
      fees::resolve_priority_fee(client, settings.fees, unsigned_wire);

  // The compute budget instructions have to come first in the message.
  solana::Transaction final_transaction;
  final_transaction.set_fee_payer(wallet.pubkey());
  final_transaction.set_recent_blockhash(blockhash->blockhash);
  final_transaction.add(
      solana::compute_budget::set_compute_unit_limit(kSwapComputeUnitLimit));
  final_transaction.add(
      solana::compute_budget::set_compute_unit_price(priority_fee));
  for (const auto& instruction : transaction.instructions()) {
    final_transaction.add(instruction);
  }

  std::uint64_t tip = 0;
  if (options.use_jito) {
    tip = fees::resolve_tip_lamports(settings.fees);
    final_transaction.add(
        fees::build_tip_instruction(wallet.pubkey(), tip));
  }

  SwapResult result;
  result.amount_in = amount_in;
  result.expected_out = prepared.expected_out;
  result.min_out = prepared.min_out;
  result.priority_fee_micro_lamports = priority_fee;
  result.jito_tip_lamports = tip;

  std::vector<std::uint8_t> wire;
  try {
    wire = final_transaction.sign_and_serialize(signers);
  } catch (const std::exception& error) {
    return SwapResult::failure(std::string("could not sign: ") + error.what());
  }

  std::optional<std::string> signature;
  if (options.use_jito) {
    signature = fees::send_bundle(wire);
    // A rejected bundle still has a valid transaction, so fall back to the
    // normal path rather than failing the order outright.
    if (!signature.has_value()) {
      Logger::instance().warn("RegularSwap",
                              "Jito rejected the bundle, retrying via RPC");
      signature = client.send_transaction(wire, options.skip_preflight);
    }
  } else {
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

bool await_confirmation(net::RpcClient& client, const std::string& signature,
                        std::chrono::seconds timeout, net::Commitment level) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;

  // Each level is satisfied by itself and anything stronger.
  const auto reached = [level](const std::string& status) {
    if (status == "finalized") return true;
    if (status == "confirmed") return level != net::Commitment::Finalized;
    if (status == "processed") return level == net::Commitment::Processed;
    return false;
  };

  while (std::chrono::steady_clock::now() < deadline) {
    auto status = client.get_signature_status(signature);
    if (status.has_value()) {
      if (*status == "failed") return false;
      if (reached(*status)) return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  return false;
}

SwapResult buy_with_sol(net::RpcClient& client, const Keypair& wallet,
                        const Pubkey& token_mint, std::uint64_t sol_lamports,
                        const SwapOptions& options) {
  const auto started = std::chrono::steady_clock::now();
  auto& logger = Logger::instance();

  auto prepared = prepare(client, token_mint, sol_lamports, true,
                          options.slippage_percent);
  if (!prepared.has_value()) {
    return SwapResult::failure("no Raydium pool for this token");
  }

  logger.info("RegularSwap",
              "Buying " + token_mint.to_base58() + " via pool " +
                  prepared->pool.amm_id.to_base58());

  // A fresh keypair holds the wrapped SOL for the life of the transaction.
  // Using a throwaway account rather than the wallet's ATA means a failed
  // swap cannot strand wrapped SOL.
  const Keypair wsol_account = Keypair::generate();

  const Pubkey destination =
      Pubkey::associated_token_address(wallet.pubkey(), token_mint);

  solana::Transaction transaction;
  transaction.set_fee_payer(wallet.pubkey());

  for (auto& instruction : build_wrapped_sol_account(
           wallet.pubkey(), wsol_account.pubkey(), sol_lamports,
           kTokenAccountRent)) {
    transaction.add(instruction);
  }

  transaction.add(solana::associated_token::create_idempotent(
      wallet.pubkey(), wallet.pubkey(), token_mint));

  transaction.add(build_raydium_swap(wallet.pubkey(), wsol_account.pubkey(),
                                     destination, prepared->pool, sol_lamports,
                                     prepared->min_out));

  // Closing returns the rent and any SOL the swap did not consume.
  transaction.add(solana::token_program::close_account(
      wsol_account.pubkey(), wallet.pubkey(), wallet.pubkey()));

  return finalize(client, wallet, transaction, {&wallet, &wsol_account},
                  options, *prepared, sol_lamports, started);
}

SwapResult sell_for_sol(net::RpcClient& client, const Keypair& wallet,
                        const Pubkey& token_mint, std::uint64_t token_amount,
                        const SwapOptions& options) {
  const auto started = std::chrono::steady_clock::now();
  auto& logger = Logger::instance();

  auto prepared = prepare(client, token_mint, token_amount, false,
                          options.slippage_percent);
  if (!prepared.has_value()) {
    return SwapResult::failure("no Raydium pool for this token");
  }

  logger.info("RegularSwap",
              "Selling " + token_mint.to_base58() + " via pool " +
                  prepared->pool.amm_id.to_base58());

  const Pubkey source =
      Pubkey::associated_token_address(wallet.pubkey(), token_mint);
  const Pubkey wsol_ata = Pubkey::associated_token_address(
      wallet.pubkey(), solana::native_mint());

  solana::Transaction transaction;
  transaction.set_fee_payer(wallet.pubkey());

  transaction.add(solana::associated_token::create_idempotent(
      wallet.pubkey(), wallet.pubkey(), solana::native_mint()));

  transaction.add(build_raydium_swap(wallet.pubkey(), source, wsol_ata,
                                     prepared->pool, token_amount,
                                     prepared->min_out));

  // Closing the WSOL account unwraps the proceeds back to the wallet.
  transaction.add(solana::token_program::close_account(
      wsol_ata, wallet.pubkey(), wallet.pubkey()));

  return finalize(client, wallet, transaction, {&wallet}, options, *prepared,
                  token_amount, started);
}

}  // namespace eclipse::swaps
