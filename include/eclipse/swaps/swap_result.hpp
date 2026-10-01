#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

namespace eclipse::swaps {

/// One timed step of a swap, for the per-stage latency breakdown.
struct StageTiming {
  std::string name;
  std::chrono::microseconds elapsed{0};
};

/// Splits a swap into consecutive timed stages. Each mark() closes the stage
/// that started at the previous mark (or at construction).
class StageTimer {
 public:
  using Clock = std::chrono::steady_clock;

  explicit StageTimer(Clock::time_point start = Clock::now())
      : started_(start), last_(start) {}

  void mark(std::string stage) {
    const auto now = Clock::now();
    stages_.push_back(
        {std::move(stage),
         std::chrono::duration_cast<std::chrono::microseconds>(now - last_)});
    last_ = now;
  }

  std::chrono::microseconds total() const {
    return std::chrono::duration_cast<std::chrono::microseconds>(
        Clock::now() - started_);
  }

  const std::vector<StageTiming>& stages() const { return stages_; }

 private:
  Clock::time_point started_;
  Clock::time_point last_;
  std::vector<StageTiming> stages_;
};

/// Outcome of a buy or sell. Failure carries a reason rather than throwing,
/// because the CLI wants to print it and return to the menu.
struct SwapResult {
  bool success = false;
  std::string signature;
  std::string error;

  std::uint64_t amount_in = 0;
  std::uint64_t expected_out = 0;
  std::uint64_t min_out = 0;

  std::uint64_t priority_fee_micro_lamports = 0;
  std::uint64_t jito_tip_lamports = 0;
  std::chrono::milliseconds elapsed{0};

  /// Filled by the paths that time themselves (the copy trader does).
  std::vector<StageTiming> stages;

  static SwapResult failure(std::string reason) {
    SwapResult result;
    result.error = std::move(reason);
    return result;
  }
};

/// Shared knobs for both venues.
struct SwapOptions {
  double slippage_percent = 1.0;
  bool use_jito = false;
  bool skip_preflight = true;
  /// Poll getSignatureStatuses until confirmed rather than returning on send.
  bool wait_for_confirmation = true;
  std::chrono::seconds confirmation_timeout{45};
};

}  // namespace eclipse::swaps
