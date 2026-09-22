#pragma once

#include <cstdint>

#include "eclipse/common/keypair.hpp"
#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/pool_accounts.hpp"
#include "eclipse/swaps/swap_result.hpp"

namespace eclipse::swaps {

/// Buys a token on Raydium by swapping SOL into it.
///
/// SOL has to be wrapped first: the path creates a temporary WSOL account,
/// swaps out of it, and closes it in the same transaction so the rent comes
/// back even when the swap reverts.
SwapResult buy_with_sol(net::RpcClient& client, const Keypair& wallet,
                        const Pubkey& token_mint, std::uint64_t sol_lamports,
                        const SwapOptions& options);

/// Sells a token back into SOL. The destination WSOL account is closed at the
/// end, which unwraps the proceeds.
SwapResult sell_for_sol(net::RpcClient& client, const Keypair& wallet,
                        const Pubkey& token_mint, std::uint64_t token_amount,
                        const SwapOptions& options);

/// Blocks until the signature reaches "confirmed" or the timeout elapses.
bool await_confirmation(net::RpcClient& client, const std::string& signature,
                        std::chrono::seconds timeout);

}  // namespace eclipse::swaps
