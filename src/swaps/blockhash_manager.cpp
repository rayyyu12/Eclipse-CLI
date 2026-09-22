#include "eclipse/swaps/blockhash_manager.hpp"

#include "eclipse/common/logger.hpp"

namespace eclipse::swaps {

BlockhashManager& BlockhashManager::instance() {
  static BlockhashManager manager;
  return manager;
}

void BlockhashManager::initialize(net::RpcClient* client) {
  if (initialized_.load()) return;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    client_ = client;
  }

  // Prime the cache so the first swap does not pay for a round trip.
  refresh();
  initialized_.store(true);

  stopping_.store(false);
  refresh_thread_ = std::thread([this] {
    while (!stopping_.load()) {
      std::unique_lock<std::mutex> lock(stop_mutex_);
      if (stop_signal_.wait_for(lock, kRefreshInterval,
                                [this] { return stopping_.load(); })) {
        return;
      }
      lock.unlock();
      refresh();
    }
  });

  Logger::instance().success("BlockhashManager", "Blockhash refresher started");
}

std::optional<net::BlockhashInfo> BlockhashManager::refresh() {
  net::RpcClient* client = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    client = client_;
  }
  if (client == nullptr) return std::nullopt;

  auto fetched = client->get_latest_blockhash();

  std::lock_guard<std::mutex> lock(mutex_);
  if (fetched.has_value()) {
    cached_ = fetched;
    fetched_at_ = std::chrono::steady_clock::now();
    last_error_.clear();
  } else {
    // Keep serving the previous hash: it may still be inside its validity
    // window, and a failed refresh is usually a transient 429.
    last_error_ = client->last_error();
  }
  return fetched;
}

std::optional<net::BlockhashInfo> BlockhashManager::get() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (cached_.has_value()) {
      const auto age = std::chrono::steady_clock::now() - fetched_at_;
      if (age < kStaleAfter) return cached_;
    }
  }
  return refresh();
}

std::string BlockhashManager::last_error() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return last_error_;
}

void BlockhashManager::cleanup() {
  if (!initialized_.load()) return;

  {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    stopping_.store(true);
  }
  stop_signal_.notify_all();

  if (refresh_thread_.joinable()) refresh_thread_.join();
  initialized_.store(false);

  Logger::instance().info("BlockhashManager", "Blockhash refresher stopped");
}

BlockhashManager::~BlockhashManager() { cleanup(); }

}  // namespace eclipse::swaps
