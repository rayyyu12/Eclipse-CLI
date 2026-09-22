#pragma once

#include <cstdint>

#include "eclipse/common/keypair.hpp"
#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/token_type_cache.hpp"
#include "eclipse/swaps/swap_result.hpp"

namespace eclipse::swaps {

/// Price on the bonding curve, using the virtual reserves.
///
/// Pump.fun quotes against virtual reserves rather than real ones, which is
/// what makes the early curve steep. Both directions are constant product.
std::uint64_t curve_buy_output(const pools::BondingCurveState& curve,
                               std::uint64_t sol_in);
std::uint64_t curve_sell_output(const pools::BondingCurveState& curve,
                                std::uint64_t tokens_in);

/// Buys on the bonding curve with SOL. Fails when the curve has completed, in
/// which case the token has graduated and the Raydium path applies.
SwapResult pump_buy(net::RpcClient& client, const Keypair& wallet,
                    const Pubkey& token_mint, std::uint64_t sol_lamports,
                    const SwapOptions& options);

/// Sells back into the curve.
SwapResult pump_sell(net::RpcClient& client, const Keypair& wallet,
                     const Pubkey& token_mint, std::uint64_t token_amount,
                     const SwapOptions& options);

}  // namespace eclipse::swaps
