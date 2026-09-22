#pragma once

#include "eclipse/common/pubkey.hpp"

namespace eclipse::swaps {

const Pubkey& pump_fun_program_id();
const Pubkey& pump_fun_global();
const Pubkey& pump_fun_fee_recipient();
const Pubkey& pump_fun_event_authority();

const Pubkey& raydium_amm_program_id();
const Pubkey& raydium_amm_authority();
const Pubkey& openbook_program_id();

/// Raydium LIQUIDITY_STATE_LAYOUT_V4 is a fixed 752 bytes.
inline constexpr std::size_t kRaydiumLiquidityStateV4Size = 752;

/// Byte offsets into LIQUIDITY_STATE_LAYOUT_V4 for the fields the CLI reads.
/// Taken from the Raydium SDK layout; the struct is a flat sequence of u64s
/// and publicKeys with no padding.
namespace raydium_v4_offset {
inline constexpr std::size_t kBaseDecimal = 32;
inline constexpr std::size_t kQuoteDecimal = 40;
inline constexpr std::size_t kBaseVault = 336;
inline constexpr std::size_t kQuoteVault = 368;
inline constexpr std::size_t kBaseMint = 400;
inline constexpr std::size_t kQuoteMint = 432;
inline constexpr std::size_t kOpenOrders = 496;
inline constexpr std::size_t kMarketId = 528;
inline constexpr std::size_t kMarketProgramId = 560;
inline constexpr std::size_t kTargetOrders = 592;
}  // namespace raydium_v4_offset

/// OpenBook MARKET_STATE_LAYOUT_V3 offsets, past the 5-byte "serum" prefix
/// and the account flags.
namespace openbook_offset {
inline constexpr std::size_t kOwnAddress = 13;
inline constexpr std::size_t kVaultSignerNonce = 45;
inline constexpr std::size_t kBaseMint = 53;
inline constexpr std::size_t kQuoteMint = 85;
inline constexpr std::size_t kBaseVault = 117;
inline constexpr std::size_t kQuoteVault = 165;
inline constexpr std::size_t kEventQueue = 253;
inline constexpr std::size_t kBids = 285;
inline constexpr std::size_t kAsks = 317;
}  // namespace openbook_offset

/// Pump.fun bonding curve account layout, after the 8-byte discriminator.
namespace pump_offset {
inline constexpr std::size_t kVirtualTokenReserves = 8;
inline constexpr std::size_t kVirtualSolReserves = 16;
inline constexpr std::size_t kRealTokenReserves = 24;
inline constexpr std::size_t kRealSolReserves = 32;
inline constexpr std::size_t kTokenTotalSupply = 40;
inline constexpr std::size_t kComplete = 48;
}  // namespace pump_offset

/// Anchor discriminators for the pump.fun instructions.
inline constexpr std::uint8_t kPumpBuyDiscriminator[8] = {
    0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea};
inline constexpr std::uint8_t kPumpSellDiscriminator[8] = {
    0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad};

/// Raydium AMM v4 SwapBaseIn.
inline constexpr std::uint8_t kRaydiumSwapBaseIn = 9;

}  // namespace eclipse::swaps
