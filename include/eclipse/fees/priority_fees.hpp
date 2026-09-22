#pragma once

#include <cstdint>
#include <vector>

#include "eclipse/cli/settings.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::fees {

/// What the CLI pays when no estimate is available, in microLamports per
/// compute unit. Matches the TypeScript build's fallback.
inline constexpr std::uint64_t kDefaultPriorityFee = 1000000;

/// Resolves the compute unit price from settings, asking the RPC for an
/// estimate when automatic mode is on. Falls back to kDefaultPriorityFee when
/// the endpoint does not implement the estimate method.
std::uint64_t resolve_priority_fee(
    net::RpcClient& client, const cli::FeeSettings& settings,
    const std::vector<std::uint8_t>& wire_transaction);

}  // namespace eclipse::fees
