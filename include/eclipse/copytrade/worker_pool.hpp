#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace eclipse::copytrade {

/// A fixed set of long-lived threads draining a FIFO queue.
///
/// Long-lived matters here more than pooled: HttpClient keeps one curl handle
/// per thread, so a thread that has already sent to the RPC and the Jito block
/// engine holds warm TLS connections to both. A thread per copy would pay a
/// fresh handshake on every trade.
class WorkerPool {
 public:
  explicit WorkerPool(std::size_t threads) {
    if (threads == 0) threads = 1;
    threads_.reserve(threads);
    for (std::size_t i = 0; i < threads; ++i) {
      threads_.emplace_back([this] { run(); });
    }
  }

  ~WorkerPool() { shutdown(); }

  WorkerPool(const WorkerPool&) = delete;
  WorkerPool& operator=(const WorkerPool&) = delete;

  /// Ignored once shutdown() has begun.
  void submit(std::function<void()> task) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) return;
      queue_.push_back(std::move(task));
    }
    ready_.notify_one();
  }

  /// Runs whatever is already queued, then joins. Safe to call twice.
  void shutdown() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    ready_.notify_all();
    for (auto& thread : threads_) {
      if (thread.joinable()) thread.join();
    }
  }

 private:
  void run() {
    while (true) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
        if (queue_.empty()) return;  // stopping, and nothing left to drain
        task = std::move(queue_.front());
        queue_.pop_front();
      }
      task();
    }
  }

  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::function<void()>> queue_;
  bool stopping_ = false;
  std::vector<std::thread> threads_;
};

}  // namespace eclipse::copytrade
