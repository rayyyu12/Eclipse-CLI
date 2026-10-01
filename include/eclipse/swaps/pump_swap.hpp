#pragma once

#include <cstdint>

#include "eclipse/common/keypair.hpp"
#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/token_type_cache.hpp"
#include "eclipse/solana/instruction.hpp"
#include "eclipse/swaps/swap_result.hpp"

namespace eclipse::swaps {

/// The accounts a pump.fun trade touches besides the program's fixed ones.
/// All of it derives locally from the mint and the user.
struct PumpTradeAccounts {
  Pubkey mint;
  Pubkey bonding_curve;
  Pubkey associated_bonding_curve;  ///< the curve's token account
  Pubkey user;
  Pubkey user_token_account;
};

/// pump.fun buy: receive exactly `token_amount`, paying at most
/// `max_sol_cost` lamports.
solana::Instruction build_pump_buy_instruction(const PumpTradeAccounts& accounts,
                                               std::uint64_t token_amount,
                                               std::uint64_t max_sol_cost);

/// pump.fun sell: give `token_amount`, receiving at least `min_sol_output`.
///
/// The account list differs from buy's after the system program: the IDL has
/// the associated token program then the token program here, where buy has
/// the token program then rent.
solana::Instruction build_pump_sell_instruction(
    const PumpTradeAccounts& accounts, std::uint64_t token_amount,
    std::uint64_t min_sol_output);

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
