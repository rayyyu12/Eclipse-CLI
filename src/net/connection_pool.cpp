#include "eclipse/net/connection_pool.hpp"

#include <algorithm>

#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/common/logger.hpp"

namespace eclipse::net {
namespace {
constexpr auto kHealthCheckInterval = std::chrono::seconds(30);
constexpr int kFailuresBeforeParking = 3;
}  // namespace

ConnectionPool& ConnectionPool::instance() {
  static ConnectionPool pool;
  return pool;
}

void ConnectionPool::initialize() { initialize(Options{}); }

void ConnectionPool::initialize(const Options& options) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (initialized_.load()) return;

  auto& logger = Logger::instance();

  std::string primary = options.primary_rpc_url;
  if (primary.empty()) {
    // Throws when no endpoint is configured; the caller reports that as a
    // setup problem rather than a crash.
    primary = cli::CredentialsManager::instance().get_rpc_url();
  }

  endpoints_.push_back(
      Endpoint{std::make_unique<RpcClient>(primary, options.commitment), true,
               0});
  last_successful_ = endpoints_.front().client.get();

  for (const auto& url : options.fallback_rpc_urls) {
    if (url == primary) continue;
    endpoints_.push_back(
        Endpoint{std::make_unique<RpcClient>(url, options.commitment), true,
                 0});
  }

  logger.info("ConnectionPool",
              "Initialized with " + std::to_string(endpoints_.size()) +
                  " connection(s)");

  initialized_.store(true);
  start_health_check();
}

void ConnectionPool::start_health_check() {
  stopping_.store(false);
  health_thread_ = std::thread([this] {
    while (!stopping_.load()) {
      std::unique_lock<std::mutex> lock(stop_mutex_);
      if (stop_signal_.wait_for(lock, kHealthCheckInterval,
                                [this] { return stopping_.load(); })) {
        return;  // woken by cleanup()
      }
      lock.unlock();
      check_health();
    }
  });
}

void ConnectionPool::check_health() {
  std::lock_guard<std::mutex> lock(mutex_);
  auto& logger = Logger::instance();

  bool any_healthy = false;

  for (std::size_t i = 0; i < endpoints_.size(); ++i) {
    auto& endpoint = endpoints_[i];

    const auto start = std::chrono::steady_clock::now();
    const bool ok = endpoint.client->get_latest_blockhash().has_value();
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start);

    if (ok) {
      endpoint.healthy = true;
      endpoint.consecutive_failures = 0;
      last_successful_ = endpoint.client.get();
      any_healthy = true;

      logger.debug("ConnectionPool",
                   "Connection " + std::to_string(i + 1) +
                       " health check passed in " +
                       std::to_string(elapsed.count()) + "ms");
    } else {
      ++endpoint.consecutive_failures;
      if (endpoint.consecutive_failures >= kFailuresBeforeParking) {
        endpoint.healthy = false;
      }
      logger.warn("ConnectionPool",
                  "Connection " + std::to_string(i + 1) +
                      " health check failed",
                  endpoint.client->last_error());
    }
  }

  // Everything is parked. Revive the endpoint that worked last rather than
  // leaving the pool with nothing to hand out.
  if (!any_healthy && last_successful_ != nullptr) {
    for (auto& endpoint : endpoints_) {
      if (endpoint.client.get() == last_successful_) {
        endpoint.healthy = true;
        endpoint.consecutive_failures = 0;
        break;
      }
    }
    logger.warn("ConnectionPool",
                "All connections unhealthy, reviving last successful one");
  }
}

RpcClient& ConnectionPool::get() {
  std::lock_guard<std::mutex> lock(mutex_);

  if (endpoints_.empty()) {
    throw std::runtime_error("connection pool has no endpoints");
  }

  const bool any_healthy =
      std::any_of(endpoints_.begin(), endpoints_.end(),
                  [](const Endpoint& e) { return e.healthy; });

  if (!any_healthy) {
    Logger::instance().warn("ConnectionPool",
                            "No healthy connections, resetting health state");
    for (auto& endpoint : endpoints_) {
      endpoint.healthy = true;
      endpoint.consecutive_failures = 0;
    }
  }

  for (std::size_t attempt = 0; attempt < endpoints_.size(); ++attempt) {
    round_robin_index_ = (round_robin_index_ + 1) % endpoints_.size();
    if (endpoints_[round_robin_index_].healthy) {
      return *endpoints_[round_robin_index_].client;
    }
  }

  if (last_successful_ != nullptr) return *last_successful_;
  return *endpoints_.front().client;
}

std::vector<RpcClient*> ConnectionPool::all() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<RpcClient*> out;
  out.reserve(endpoints_.size());
  for (auto& endpoint : endpoints_) out.push_back(endpoint.client.get());
  return out;
}

void ConnectionPool::cleanup() {
  if (!initialized_.load()) return;

  {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    stopping_.store(true);
  }
  stop_signal_.notify_all();

  if (health_thread_.joinable()) health_thread_.join();
  Logger::instance().info("ConnectionPool", "Connection pool cleaned up");
}

ConnectionPool::~ConnectionPool() { cleanup(); }

}  // namespace eclipse::net
