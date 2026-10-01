#include "eclipse/copytrade/types.hpp"

#include <type_traits>

namespace eclipse::copytrade {

const char* to_string(SwapType type) {
  switch (type) {
    case SwapType::Raydium: return "raydium";
    case SwapType::Pump:    return "pump";
    case SwapType::Unknown: return "unknown";
  }
  return "unknown";
}

const char* to_string(MonitorErrorType type) {
  // The TypeScript build's error type strings, so log lines read the same.
  switch (type) {
    case MonitorErrorType::Startup:      return "STARTUP_ERROR";
    case MonitorErrorType::Subscription: return "SUBSCRIPTION_ERROR";
    case MonitorErrorType::MaxReconnect: return "MAX_RECONNECT_ERROR";
    case MonitorErrorType::Parse:        return "PARSE_ERROR";
    case MonitorErrorType::Execution:    return "EXECUTION_ERROR";
    case MonitorErrorType::Validation:   return "VALIDATION_ERROR";
  }
  return "UNKNOWN_ERROR";
}

const BaseSwapData& base_of(const ParsedSwap& swap) {
  return std::visit(
      [](const auto& data) -> const BaseSwapData& { return data; }, swap);
}

SwapType type_of(const ParsedSwap& swap) {
  return std::visit(
      [](const auto& data) { return std::decay_t<decltype(data)>::kType; },
      swap);
}

}  // namespace eclipse::copytrade
