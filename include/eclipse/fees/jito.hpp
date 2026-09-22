#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/pubkey.hpp"
#include "eclipse/solana/instruction.hpp"

namespace eclipse::fees {

/// Jito's published tip percentiles, in SOL.
struct TipFloor {
  double p25 = 0.0;
  double p50 = 0.0;
  double p75 = 0.0;
  double p95 = 0.0;
  double ema_p50 = 0.0;
};

/// One of the eight tip accounts, chosen at random per bundle so tips are not
/// all aimed at the same account.
const Pubkey& random_tip_account();

/// Cached for 30 seconds; the endpoint is rate-limited and the floor moves
/// slowly. nullopt when unreachable.
std::optional<TipFloor> get_tip_floor();

/// Resolves the tip from settings: a fixed amount, or a percentile chosen by
/// the configured aggressiveness. Never returns less than 1000 lamports,
/// which is the minimum Jito accepts.
std::uint64_t resolve_tip_lamports(const cli::FeeSettings& settings);

/// A transfer to a Jito tip account. Appended to the transaction rather than
/// sent as a separate bundle entry.
solana::Instruction build_tip_instruction(const Pubkey& payer,
                                          std::uint64_t lamports);

/// Submits through the Jito block engine instead of the normal RPC. Returns
/// the bundle id on success.
std::optional<std::string> send_bundle(
    const std::vector<std::uint8_t>& wire_transaction);

}  // namespace eclipse::fees
