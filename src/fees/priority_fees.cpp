#include "eclipse/fees/priority_fees.hpp"

#include "eclipse/common/logger.hpp"

namespace eclipse::fees {

std::uint64_t resolve_priority_fee(
    net::RpcClient& client, const cli::FeeSettings& settings,
    const std::vector<std::uint8_t>& wire_transaction) {
  if (!settings.use_automatic_priority_fee) {
    return settings.fixed_priority_fee.value_or(kDefaultPriorityFee);
  }

  auto estimate = client.get_priority_fee_estimate(wire_transaction);
  if (estimate.has_value() && *estimate > 0) return *estimate;

  // getPriorityFeeEstimate is a Helius extension. Anything else answers with
  // a method-not-found error, which is expected rather than a failure.
  Logger::instance().debug("PriorityFees",
                           "No estimate available, using default",
                           client.last_error());

  return settings.fixed_priority_fee.value_or(kDefaultPriorityFee);
}

}  // namespace eclipse::fees
