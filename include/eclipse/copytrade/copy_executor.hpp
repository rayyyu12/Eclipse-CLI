#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/keypair.hpp"
#include "eclipse/copytrade/types.hpp"
#include "eclipse/copytrade/worker_pool.hpp"

namespace eclipse::copytrade {

/// How much SOL a copy buy spends, in lamports: the fixed amount, or in
/// mirror mode what the followed wallet spent. nullopt, with the reason in
/// `error`, when the amount falls outside the configured minimum and maximum.
///
/// As in executeCopyTrade, the bounds apply to the amount being spent, so in
/// fixed mode they only reject a fixed amount that is itself out of range.
std::optional<std::uint64_t> resolve_buy_lamports(
    const cli::CopyTradeSettings& settings, double followed_amount_sol,
    std::string* error = nullptr);

/// Raw units for a UI amount, rounded down.
std::uint64_t to_raw_amount(double ui_amount, int decimals);

/// Runs the copies: executeCopyTrade from transactionMonitor.ts.
///
/// Two pools. The send workers do everything up to and including handing the
/// transaction to Jito, then pass it on; the confirmation workers poll its
/// status and update the position. A copy waiting on confirmation therefore
/// never holds up the next one, which the TypeScript build got for free from
/// not awaiting its event handler.
class CopyExecutor {
 public:
  struct Outcome {
    bool success = false;
    SwapType protocol = SwapType::Unknown;
    bool is_buy = false;
    std::string token_address;
    std::string original_signature;
    std::string copy_signature;
    std::string error;
    std::chrono::milliseconds execution_time{0};
  };
  using OutcomeHandler = std::function<void(const Outcome&)>;

  struct Options {
    std::size_t send_workers = 4;
    std::size_t confirmation_workers = 4;
    std::chrono::seconds confirmation_timeout{45};
  };

  static CopyExecutor& instance();

  /// Loads the wallet once, so no copy pays for decrypting the credential
  /// store. Throws std::runtime_error when no private key is configured.
  /// Later calls are ignored while running.
  void start();
  void start(const Options& options);

  /// Lets queued and in-flight copies finish (a pending confirmation can take
  /// up to the confirmation timeout), then joins.
  void stop();

  bool running() const { return running_.load(); }

  /// The wallet copies are made from, so the monitor can skip its own trades.
  std::string wallet_address() const;

  /// Queues a copy and returns. `received_at` is when the followed
  /// transaction came off the stream; `on_done` runs on a worker thread once
  /// the copy has confirmed or failed.
  void submit(ParsedSwap swap,
              std::chrono::steady_clock::time_point received_at,
              OutcomeHandler on_done);

  ~CopyExecutor();

 private:
  CopyExecutor() = default;

  struct PendingCopy;

  void execute(const ParsedSwap& swap,
               std::chrono::steady_clock::time_point received_at,
               const OutcomeHandler& on_done);
  void confirm(PendingCopy pending);

  mutable std::mutex mutex_;
  Options options_;
  Keypair wallet_;
  std::unique_ptr<WorkerPool> send_pool_;
  std::unique_ptr<WorkerPool> confirmation_pool_;
  std::atomic<bool> running_{false};
};

}  // namespace eclipse::copytrade
