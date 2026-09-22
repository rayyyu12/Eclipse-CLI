#pragma once

#include <optional>
#include <vector>

#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/pool_accounts.hpp"

namespace eclipse::pools {

/// Finds the Raydium pool for a mint pair, trying both orientations since
/// either side can be the base.
///
/// This is a getProgramAccounts scan with memcmp filters on the mint offsets,
/// which is heavy: results go through PersistentPoolCache.
std::optional<PoolAccounts> discover_pool(net::RpcClient& client,
                                          const Pubkey& mint_a,
                                          const Pubkey& mint_b,
                                          bool use_cache = true);

/// Every pool holding the given mint, in either orientation. Used by the pool
/// selector to compare quotes.
std::vector<PoolAccounts> find_all_pools(net::RpcClient& client,
                                         const Pubkey& mint,
                                         std::size_t limit = 8);

}  // namespace eclipse::pools
