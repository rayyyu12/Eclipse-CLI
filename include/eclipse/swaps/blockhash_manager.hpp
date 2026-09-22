#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "eclipse/net/rpc_client.hpp"

namespace eclipse::swaps {

/// Keeps a recent blockhash warm in the background.
///
/// Fetching one inside the send path costs a round trip at the worst moment,
/// so a refresher thread polls every two seconds and the send path reads the
/// cached value. A hash older than 30 seconds is treated as stale and fetched
/// synchronously instead.
class BlockhashManager {
 public:
  static BlockhashManager& instance();

  void initialize(net::RpcClient* client);
  bool initialized() const { return initialized_.load(); }

  /// Cached when fresh, otherwise fetched. nullopt only when the RPC is down.
  std::optional<net::BlockhashInfo> get();

  /// Forces a fetch, ignoring the cache.
  std::optional<net::BlockhashInfo> refresh();

  std::string last_error() const;

  void cleanup();
  ~BlockhashManager();

 private:
  BlockhashManager() = default;

  static constexpr auto kRefreshInterval = std::chrono::seconds(2);
  static constexpr auto kStaleAfter = std::chrono::seconds(30);

  mutable std::mutex mutex_;
  net::RpcClient* client_ = nullptr;
  std::optional<net::BlockhashInfo> cached_;
  std::chrono::steady_clock::time_point fetched_at_;
  std::string last_error_;

  std::atomic<bool> initialized_{false};
  std::atomic<bool> stopping_{false};
  std::thread refresh_thread_;
  std::condition_variable stop_signal_;
  std::mutex stop_mutex_;
};

}  // namespace eclipse::swaps
