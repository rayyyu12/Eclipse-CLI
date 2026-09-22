#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "eclipse/net/rpc_client.hpp"

namespace eclipse::net {

/// Round-robin over one or more RPC endpoints, with a background health check
/// every 30 seconds. An endpoint is parked after three consecutive failures
/// and revived if every endpoint goes down, so the CLI degrades rather than
/// dying when a provider rate-limits.
class ConnectionPool {
 public:
  struct Options {
    std::string primary_rpc_url;
    std::vector<std::string> fallback_rpc_urls;
    Commitment commitment = Commitment::Confirmed;
  };

  static ConnectionPool& instance();

  /// Reads the primary endpoint from the credential store when the options
  /// leave it blank. Safe to call more than once; later calls are ignored.
  ///
  /// Two overloads rather than a defaulted argument: Options is a nested type
  /// with default member initializers, so `= {}` would be evaluated before the
  /// enclosing class is complete.
  void initialize();
  void initialize(const Options& options);

  bool initialized() const { return initialized_.load(); }

  /// Never null once initialised. Falls back to the last endpoint known to
  /// work, then to the first one configured.
  RpcClient& get();

  std::vector<RpcClient*> all();

  void cleanup();

  ~ConnectionPool();

 private:
  ConnectionPool() = default;

  void start_health_check();
  void check_health();

  struct Endpoint {
    std::unique_ptr<RpcClient> client;
    bool healthy = true;
    int consecutive_failures = 0;
  };

  mutable std::mutex mutex_;
  std::vector<Endpoint> endpoints_;
  std::size_t round_robin_index_ = 0;
  RpcClient* last_successful_ = nullptr;

  std::atomic<bool> initialized_{false};
  std::atomic<bool> stopping_{false};
  std::thread health_thread_;
  std::condition_variable stop_signal_;
  std::mutex stop_mutex_;
};

}  // namespace eclipse::net
