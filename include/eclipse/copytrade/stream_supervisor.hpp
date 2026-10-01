#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "eclipse/copytrade/geyser_client.hpp"
#include "eclipse/copytrade/types.hpp"

namespace eclipse::copytrade {

/// Keeps one Subscribe stream alive: the reconnect and stale-stream logic the
/// TypeScript TransactionMonitor and BalanceMonitor each carried a copy of.
///
///   - When the stream ends, reconnect at once. A failed reconnect is retried
///     after 5 seconds. Five failures in a row give up and report
///     MaxReconnect; a successful reconnect resets the count.
///   - Every 30 seconds, if nothing has arrived for 60, cancel the stream so
///     the loop above reconnects it. The check arms on the first update of
///     each stream, so a quiet one is not torn down before anything arrived.
///
/// The stream runs on its own thread, and the handlers are called there.
class StreamSupervisor {
 public:
  struct Options {
    std::string module;  ///< log module name
    GeyserOptions geyser;
    std::chrono::seconds stale_check_interval{30};
    int max_reconnect_attempts = 5;
    std::chrono::seconds retry_delay{5};
  };

  using ErrorHandler =
      std::function<void(MonitorErrorType type, const std::string& message)>;

  StreamSupervisor(Options options, SubscriptionRequest request,
                   StreamHandlers handlers, ErrorHandler on_error);
  ~StreamSupervisor();

  StreamSupervisor(const StreamSupervisor&) = delete;
  StreamSupervisor& operator=(const StreamSupervisor&) = delete;

  /// Returns once the first subscription is live. Throws std::runtime_error
  /// with the reason when it cannot be established.
  void start();

  void stop();

  /// False after stop(), or once reconnecting has been given up.
  bool active() const { return active_.load(); }

 private:
  void run();
  void watch();
  bool wait_or_stop(std::chrono::seconds duration);

  Options options_;
  SubscriptionRequest request_;
  StreamHandlers handlers_;
  ErrorHandler on_error_;
  GeyserClient client_;

  std::atomic<bool> active_{false};
  std::atomic<bool> stopping_{false};
  std::atomic<int> reconnect_attempts_{0};

  /// steady_clock ticks of the last update on the current stream; 0 = none.
  std::atomic<std::chrono::steady_clock::rep> last_message_{0};

  // First-connection handshake between start() and the stream thread.
  std::mutex startup_mutex_;
  std::condition_variable startup_signal_;
  bool startup_done_ = false;
  std::string startup_error_;

  std::mutex stop_mutex_;
  std::condition_variable stop_signal_;

  std::thread stream_thread_;
  std::thread watchdog_thread_;
};

}  // namespace eclipse::copytrade
