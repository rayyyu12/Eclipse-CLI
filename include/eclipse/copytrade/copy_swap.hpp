#pragma once

#include <cstdint>
#include <optional>

#include "eclipse/common/keypair.hpp"
#include "eclipse/copytrade/types.hpp"
#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/token_type_cache.hpp"
#include "eclipse/swaps/swap_result.hpp"

namespace eclipse::copytrade {

// The copy swaps: pumpCopySwap.ts and raydiumCopySwap.ts.
//
// They differ from the manual buy and sell paths in what they leave out, all
// of it for latency:
//
//   - The Raydium pool comes from the followed transaction, so there is no
//     pool discovery, no market fetch and no reserve read. The minimum output
//     is computed from the pool balances in that transaction's meta.
//   - The priority fee is the configured fixed fee (or 100k microLamports),
//     never an RPC estimate.
//   - The blockhash is BlockhashManager's cached one.
//   - Token accounts are created idempotently instead of probed.
//   - The transaction goes to the Jito block engine with a tip, skipping
//     preflight. There is no RPC fallback.
//
// Each returns as soon as the transaction is accepted; the signature is
// computed locally from the signed bytes. Confirmation is the caller's job, so
// the thread that sent the transaction is free for the next copy. Every stage
// is recorded on the timer passed in.

/// What the TypeScript copy path paid per compute unit when no fixed priority
/// fee was configured (DEFAULT_PRIORITY_FEE in both copy swap files).
inline constexpr std::uint64_t kCopyDefaultPriorityFee = 100000;

/// The compute unit limit both copy transactions request.
inline constexpr std::uint32_t kCopyComputeUnitLimit = 200000;

/// Allowance for Raydium's 0.25% pool fee, taken off the minimum output on
/// top of the slippage tolerance (POOL_FEE_BUFFER).
inline constexpr double kRaydiumPoolFeeBuffer = 0.003;

/// pump.fun buy sizing: the tokens the curve gives for `lamports`, which the
/// buy requests exactly, and the SOL ceiling slippage allows.
struct PumpBuyQuote {
  std::uint64_t expected_tokens = 0;
  std::uint64_t max_sol_cost = 0;
};
PumpBuyQuote quote_pump_copy_buy(const pools::BondingCurveState& curve,
                                 std::uint64_t lamports,
                                 double slippage_percent);

struct PumpSellQuote {
  std::uint64_t expected_sol = 0;
  std::uint64_t min_sol_output = 0;
};
PumpSellQuote quote_pump_copy_sell(const pools::BondingCurveState& curve,
                                   std::uint64_t token_amount,
                                   double slippage_percent);

/// Raydium sizing from the followed trade's pre-trade vault balances.
///
/// This is calculateSwapOutput from raydiumCopySwap.ts, carried over as is:
/// a price ratio of the vault balances in UI units with a fixed 10^-4 scale,
/// not a constant-product quote. With the default 50% tolerance it yields a
/// loose floor rather than a tight one. nullopt when the coin vault balance is
/// missing, which the TypeScript build would have divided by.
struct RaydiumCopyQuote {
  std::uint64_t expected_output = 0;
  std::uint64_t min_amount_out = 0;
};
std::optional<RaydiumCopyQuote> quote_raydium_copy(
    std::uint64_t amount_in, const PoolBalances& pool_balances,
    int token_decimals, double slippage_percent);

swaps::SwapResult copy_pump_buy(net::RpcClient& client, const Keypair& wallet,
                                const PumpSwapData& swap,
                                std::uint64_t amount_in_lamports,
                                double slippage_percent,
                                swaps::StageTimer& timer);

swaps::SwapResult copy_pump_sell(net::RpcClient& client, const Keypair& wallet,
                                 const PumpSwapData& swap,
                                 std::uint64_t token_amount,
                                 double slippage_percent,
                                 swaps::StageTimer& timer);

/// Buys or sells per swap.is_buy. On a buy `amount_in` is lamports and SOL is
/// wrapped into the wallet's WSOL account first; on a sell it is raw token
/// units and the WSOL account is closed afterwards to unwrap the proceeds.
///
/// Takes no RPC client: nothing on this path makes a round trip before the
/// send.
swaps::SwapResult copy_raydium_swap(const Keypair& wallet,
                                    const RaydiumSwapData& swap,
                                    std::uint64_t amount_in,
                                    double slippage_percent,
                                    swaps::StageTimer& timer);

}  // namespace eclipse::copytrade
