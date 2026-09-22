#pragma once

#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

#include "eclipse/pools/pool_accounts.hpp"

namespace eclipse::pools {

/// Disk-backed cache of resolved pools, keyed by "baseMint/quoteMint".
///
/// Pool discovery is a getProgramAccounts scan that some providers rate-limit
/// hard, and a pool's account set never changes once created, so entries are
/// kept indefinitely.
class PersistentPoolCache {
 public:
  static PersistentPoolCache& instance();

  std::optional<PoolAccounts> get(const std::string& pool_id) const;
  void put(const std::string& pool_id, const PoolAccounts& accounts);

  bool contains(const std::string& pool_id) const;
  std::size_t size() const;
  void clear();

  /// Writes through to disk. Called on put, and again at shutdown.
  void flush() const;

 private:
  PersistentPoolCache();

  void load();

  mutable std::mutex mutex_;
  std::string path_;
  std::unordered_map<std::string, PoolAccounts> cache_;
};

}  // namespace eclipse::pools
