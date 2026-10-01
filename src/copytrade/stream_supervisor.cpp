#include "eclipse/copytrade/stream_supervisor.hpp"

#include <stdexcept>

#include "eclipse/common/logger.hpp"

namespace eclipse::copytrade {
namespace {

using Clock = std::chrono::steady_clock;

/// Slack on top of the connect timeout before start() stops waiting for the
/// first subscription; covers the request write after the channel is up.
constexpr auto kStartupGrace = std::chrono::seconds(15);

}  // namespace

StreamSupervisor::StreamSupervisor(Options options, SubscriptionRequest request,
                                   StreamHandlers handlers,
                                   ErrorHandler on_error)
    : options_(std::move(options)),
      request_(std::move(request)),
      handlers_(std::move(handlers)),
      on_error_(std::move(on_error)),
      client_(options_.geyser) {}

StreamSupervisor::~StreamSupervisor() { stop(); }

void StreamSupervisor::start() {
  if (active_.load() || stream_thread_.joinable()) return;

  {
    std::lock_guard<std::mutex> lock(startup_mutex_);
    startup_done_ = false;
    startup_error_.clear();
  }
  stopping_.store(false);
  reconnect_attempts_.store(0);

  stream_thread_ = std::thread([this] { run(); });

  std::unique_lock<std::mutex> lock(startup_mutex_);
  const bool finished = startup_signal_.wait_for(
      lock, options_.geyser.connect_timeout + kStartupGrace,
      [this] { return startup_done_; });

  std::string error;
  if (!finished) {
    error = "timed out waiting for the subscription";
  } else {
    error = startup_error_;
  }
  lock.unlock();

  if (!error.empty()) {
    stop();
    throw std::runtime_error(error);
  }

  watchdog_thread_ = std::thread([this] { watch(); });
}

void StreamSupervisor::stop() {
  {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    stopping_.store(true);
  }
  stop_signal_.notify_all();
  client_.shutdown();

  if (stream_thread_.joinable()) stream_thread_.join();
  if (watchdog_thread_.joinable()) watchdog_thread_.join();
  active_.store(false);
}

bool StreamSupervisor::wait_or_stop(std::chrono::seconds duration) {
  std::unique_lock<std::mutex> lock(stop_mutex_);
  return stop_signal_.wait_for(lock, duration,
                               [this] { return stopping_.load(); });
}

void StreamSupervisor::run() {
  auto& logger = Logger::instance();
  const std::string& module = options_.module;
  bool first = true;

  const auto finish_startup = [this](const std::string& error) {
    {
      std::lock_guard<std::mutex> lock(startup_mutex_);
      startup_done_ = true;
      startup_error_ = error;
    }
    startup_signal_.notify_all();
  };

  while (!stopping_.load()) {
    bool subscribed = false;

    StreamHandlers wrapped = handlers_;
    wrapped.on_subscribed = [&] {
      subscribed = true;
      last_message_.store(0);  // the stale check re-arms on this stream
      active_.store(true);

      if (first) {
        finish_startup({});
      } else {
        reconnect_attempts_.store(0);
        logger.success(module, "Successfully reconnected");
      }
      if (handlers_.on_subscribed) handlers_.on_subscribed();
    };
    wrapped.on_message = [this] {
      last_message_.store(Clock::now().time_since_epoch().count());
      if (handlers_.on_message) handlers_.on_message();
    };

    const std::string reason = client_.subscribe(request_, wrapped);
    if (stopping_.load()) break;

    if (first && !subscribed) {
      // The first connection failing is a startup error, reported to the
      // caller of start() rather than retried, as in the TypeScript build.
      finish_startup(reason.empty() ? "could not subscribe" : reason);
      return;
    }
    first = false;

    if (subscribed) {
      logger.warn(module, "Subscription ended unexpectedly", reason);
      if (on_error_) {
        on_error_(MonitorErrorType::Subscription,
                  reason.empty() ? "stream ended" : reason);
      }
    } else {
      logger.error(module, "Reconnection attempt failed", reason);
    }

    if (reconnect_attempts_.load() >= options_.max_reconnect_attempts) {
      logger.error(module, "Max reconnection attempts reached");
      active_.store(false);
      if (on_error_) {
        on_error_(MonitorErrorType::MaxReconnect,
                  "Failed to reconnect after maximum attempts");
      }
      break;
    }

    const int attempt = ++reconnect_attempts_;
    logger.info(module, "Attempting to reconnect (attempt " +
                            std::to_string(attempt) + "/" +
                            std::to_string(options_.max_reconnect_attempts) +
                            ")...");

    // A stream that ended is retried at once; a reconnect that failed waits.
    if (!subscribed && wait_or_stop(options_.retry_delay)) break;
  }

  active_.store(false);
}

void StreamSupervisor::watch() {
  const auto stale_after = options_.stale_check_interval * 2;

  while (!wait_or_stop(options_.stale_check_interval)) {
    const auto last = last_message_.load();
    if (last == 0) continue;

    const auto age = Clock::now() - Clock::time_point(Clock::duration(last));
    if (age <= stale_after) continue;

    const auto seconds =
        std::chrono::duration_cast<std::chrono::seconds>(age).count();
    Logger::instance().warn(options_.module,
                            "No updates received for " +
                                std::to_string(seconds) + "s; reconnecting");
    last_message_.store(0);
    client_.cancel_current();
  }
}

}  // namespace eclipse::copytrade
