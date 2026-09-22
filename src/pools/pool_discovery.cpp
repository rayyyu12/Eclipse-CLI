#include "eclipse/pools/pool_discovery.hpp"

#include "eclipse/common/logger.hpp"
#include "eclipse/pools/persistent_pool_cache.hpp"
#include "eclipse/pools/pool_parser.hpp"
#include "eclipse/swaps/constants.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace eclipse::pools {
namespace {
namespace ray = swaps::raydium_v4_offset;

/// One getProgramAccounts scan filtered to a (base, quote) orientation.
std::vector<net::ProgramAccount> scan(net::RpcClient& client,
                                      const Pubkey& base, const Pubkey& quote) {
  const std::vector<net::MemcmpFilter> filters = {
      {ray::kBaseMint, base.to_base58()},
      {ray::kQuoteMint, quote.to_base58()},
  };

  auto accounts = client.get_program_accounts(
      swaps::raydium_amm_program_id(),
      swaps::kRaydiumLiquidityStateV4Size, filters);

  return accounts.value_or(std::vector<net::ProgramAccount>{});
}

}  // namespace

std::optional<PoolAccounts> discover_pool(net::RpcClient& client,
                                          const Pubkey& mint_a,
                                          const Pubkey& mint_b,
                                          bool use_cache) {
  auto& logger = Logger::instance();
  auto& cache = PersistentPoolCache::instance();

  const std::string forward_id = mint_a.to_base58() + "/" + mint_b.to_base58();
  const std::string reverse_id = mint_b.to_base58() + "/" + mint_a.to_base58();

  if (use_cache) {
    if (auto hit = cache.get(forward_id)) return hit;
    if (auto hit = cache.get(reverse_id)) return hit;
  }

  // Either mint can be the base, so both orientations are tried before
  // concluding there is no pool.
  auto candidates = scan(client, mint_a, mint_b);
  if (candidates.empty()) candidates = scan(client, mint_b, mint_a);

  if (candidates.empty()) {
    logger.debug("PoolDiscovery",
                 "No Raydium pool for " + mint_a.to_base58() + " / " +
                     mint_b.to_base58());
    return std::nullopt;
  }

  auto parsed = parse_pool_info(client, candidates.front().address);
  if (!parsed.has_value()) return std::nullopt;

  if (use_cache) cache.put(parsed->id, *parsed);
  logger.debug("PoolDiscovery", "Resolved pool " + parsed->id);
  return parsed;
}

std::vector<PoolAccounts> find_all_pools(net::RpcClient& client,
                                         const Pubkey& mint,
                                         std::size_t limit) {
  std::vector<PoolAccounts> pools;

  for (const std::size_t offset : {ray::kBaseMint, ray::kQuoteMint}) {
    auto accounts = client.get_program_accounts(
        swaps::raydium_amm_program_id(),
        swaps::kRaydiumLiquidityStateV4Size,
        {{offset, mint.to_base58()}});

    if (!accounts.has_value()) continue;

    for (const auto& account : *accounts) {
      if (pools.size() >= limit) return pools;

      // Resolving the market for every hit would be one round trip each, so
      // the state is decoded locally and only the survivors are resolved.
      auto state = decode_pool_state(account.data);
      if (!state.has_value()) continue;

      auto parsed = parse_pool_info(client, account.address);
      if (parsed.has_value()) pools.push_back(std::move(*parsed));
    }
  }

  return pools;
}

}  // namespace eclipse::pools
