#pragma once

#include <chrono>
#include <cstdint>
#include <string>

namespace eclipse::swaps {

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
