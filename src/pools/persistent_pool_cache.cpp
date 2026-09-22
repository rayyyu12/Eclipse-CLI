#include "eclipse/pools/persistent_pool_cache.hpp"

#include <fstream>
#include <nlohmann/json.hpp>

#include "eclipse/common/logger.hpp"

namespace eclipse::pools {
namespace {

using Json = nlohmann::json;

constexpr const char* kCacheFile = "pools-cache.json";

Json to_json(const PoolAccounts& p) {
  return Json{
      {"id", p.id},
      {"ammId", p.amm_id.to_base58()},
      {"ammAuthority", p.amm_authority.to_base58()},
      {"ammOpenOrders", p.amm_open_orders.to_base58()},
      {"ammTargetOrders", p.amm_target_orders.to_base58()},
      {"poolCoinTokenAccount", p.pool_coin_token_account.to_base58()},
      {"poolPcTokenAccount", p.pool_pc_token_account.to_base58()},
      {"serumProgramId", p.serum_program_id.to_base58()},
      {"serumMarket", p.serum_market.to_base58()},
      {"serumBids", p.serum_bids.to_base58()},
      {"serumAsks", p.serum_asks.to_base58()},
      {"serumEventQueue", p.serum_event_queue.to_base58()},
      {"serumCoinVaultAccount", p.serum_coin_vault_account.to_base58()},
      {"serumPcVaultAccount", p.serum_pc_vault_account.to_base58()},
      {"serumVaultSigner", p.serum_vault_signer.to_base58()},
      {"baseMint", p.base_mint.to_base58()},
      {"quoteMint", p.quote_mint.to_base58()},
      {"baseDecimals", p.base_decimals},
      {"quoteDecimals", p.quote_decimals},
  };
}

/// Returns nullopt when any address fails to parse, so a cache file written by
/// an older build cannot feed a malformed account into a transaction.
std::optional<PoolAccounts> from_json(const Json& j) {
  const auto key = [&j](const char* name) -> std::optional<Pubkey> {
    if (!j.contains(name) || !j[name].is_string()) return std::nullopt;
    return Pubkey::try_parse(j[name].get<std::string>());
  };

  PoolAccounts p;
  p.id = j.value("id", "");

  const struct {
    const char* name;
    Pubkey* target;
  } fields[] = {
      {"ammId", &p.amm_id},
      {"ammAuthority", &p.amm_authority},
      {"ammOpenOrders", &p.amm_open_orders},
      {"ammTargetOrders", &p.amm_target_orders},
      {"poolCoinTokenAccount", &p.pool_coin_token_account},
      {"poolPcTokenAccount", &p.pool_pc_token_account},
      {"serumProgramId", &p.serum_program_id},
      {"serumMarket", &p.serum_market},
      {"serumBids", &p.serum_bids},
      {"serumAsks", &p.serum_asks},
      {"serumEventQueue", &p.serum_event_queue},
      {"serumCoinVaultAccount", &p.serum_coin_vault_account},
      {"serumPcVaultAccount", &p.serum_pc_vault_account},
      {"serumVaultSigner", &p.serum_vault_signer},
      {"baseMint", &p.base_mint},
      {"quoteMint", &p.quote_mint},
  };

  for (const auto& field : fields) {
    auto parsed = key(field.name);
    if (!parsed.has_value()) return std::nullopt;
    *field.target = *parsed;
  }

  p.base_decimals = j.value("baseDecimals", 0);
  p.quote_decimals = j.value("quoteDecimals", 0);
  return p;
}

}  // namespace

PersistentPoolCache& PersistentPoolCache::instance() {
  static PersistentPoolCache cache;
  return cache;
}

PersistentPoolCache::PersistentPoolCache() : path_(kCacheFile) { load(); }

void PersistentPoolCache::load() {
  std::ifstream file(path_);
  if (!file.is_open()) return;

  Json parsed = Json::parse(file, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) {
    Logger::instance().warn("PoolCache",
                            "Ignoring unreadable cache file " + path_);
    return;
  }

  std::size_t skipped = 0;
  for (const auto& [id, entry] : parsed.items()) {
    auto accounts = from_json(entry);
    if (accounts.has_value()) {
      cache_.emplace(id, std::move(*accounts));
    } else {
      ++skipped;
    }
  }

  Logger::instance().debug(
      "PoolCache", "Loaded " + std::to_string(cache_.size()) + " pool(s)" +
                       (skipped > 0 ? ", skipped " + std::to_string(skipped) +
                                          " malformed"
                                    : ""));
}

void PersistentPoolCache::flush() const {
  Json out = Json::object();
  for (const auto& [id, accounts] : cache_) out[id] = to_json(accounts);

  std::ofstream file(path_);
  if (!file.is_open()) {
    Logger::instance().warn("PoolCache", "Could not write cache to " + path_);
    return;
  }
  file << out.dump(2) << '\n';
}

std::optional<PoolAccounts> PersistentPoolCache::get(
    const std::string& pool_id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto found = cache_.find(pool_id);
  if (found == cache_.end()) return std::nullopt;
  return found->second;
}

void PersistentPoolCache::put(const std::string& pool_id,
                              const PoolAccounts& accounts) {
  std::lock_guard<std::mutex> lock(mutex_);
  cache_[pool_id] = accounts;
  flush();
}

bool PersistentPoolCache::contains(const std::string& pool_id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return cache_.count(pool_id) > 0;
}

std::size_t PersistentPoolCache::size() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return cache_.size();
}

void PersistentPoolCache::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  cache_.clear();
  flush();
}

}  // namespace eclipse::pools
