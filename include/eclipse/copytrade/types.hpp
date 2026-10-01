#pragma once

#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include "eclipse/common/pubkey.hpp"
#include "eclipse/pools/pool_accounts.hpp"

namespace eclipse::copytrade {

/// Which venue a detected trade went through.
enum class SwapType { Raydium, Pump, Unknown };
const char* to_string(SwapType type);

// --- A streamed transaction ---------------------------------------------------
//
// Yellowstone delivers SubscribeUpdateTransaction protobufs. They are decoded
// into these plain structs at the edge of the gRPC client, so everything that
// reads a transaction (detection, decoding, the copy itself) builds and tests
// without gRPC.

struct CompiledInstruction {
  std::uint32_t program_id_index = 0;
  std::vector<std::uint8_t> accounts;  ///< indices into account_keys
  std::vector<std::uint8_t> data;
};

/// The CPIs one top-level instruction made, in execution order.
struct InnerInstructions {
  std::uint32_t index = 0;  ///< the top-level instruction they belong to
  std::vector<CompiledInstruction> instructions;
};

struct UiTokenAmount {
  double ui_amount = 0.0;
  std::uint32_t decimals = 0;
  std::string amount;  ///< raw, as a decimal string
};

/// One entry of meta.preTokenBalances / meta.postTokenBalances.
struct TokenBalance {
  std::uint32_t account_index = 0;
  std::string mint;
  std::string owner;
  UiTokenAmount ui_token_amount;
};

struct TransactionUpdate {
  std::string signature;  ///< base58
  std::uint64_t slot = 0;

  /// The message's static keys followed by any addresses loaded from lookup
  /// tables (writable, then readonly). That is the index space instructions
  /// and token balances refer to.
  std::vector<Pubkey> account_keys;

  std::vector<CompiledInstruction> instructions;
  std::vector<InnerInstructions> inner_instructions;
  std::vector<std::string> log_messages;

  std::vector<std::uint64_t> pre_balances;   ///< lamports, per account key
  std::vector<std::uint64_t> post_balances;
  std::vector<TokenBalance> pre_token_balances;
  std::vector<TokenBalance> post_token_balances;

  bool failed = false;  ///< meta.err was set

  /// When the update came off the stream, for the dispatch-latency figure.
  std::chrono::steady_clock::time_point received_at;
};

// --- A decoded trade -----------------------------------------------------------

/// Fields common to both venues (BaseSwapData in the TypeScript build).
struct BaseSwapData {
  Pubkey token_address;  ///< the mint that was bought or sold
  std::string wallet_address;
  std::string signature;
  bool is_buy = false;
  bool success = false;

  /// UI units: SOL on the SOL side, tokens on the token side.
  double amount_in = 0.0;
  double amount_out = 0.0;

  std::chrono::system_clock::time_point timestamp;
};

struct PumpSwapData : BaseSwapData {
  static constexpr SwapType kType = SwapType::Pump;

  Pubkey bonding_curve;
  Pubkey associated_bonding_curve;
  Pubkey user_token_account;  ///< the followed wallet's token account

  /// 9 for SOL, 6 for pump.fun tokens.
  int decimals_in = 0;
  int decimals_out = 0;
};

/// One side of a Raydium pool, before and after the followed trade.
struct PoolSideBalance {
  double pre = 0.0;  ///< UI units
  double post = 0.0;
  std::uint32_t decimals = 0;
};

struct PoolBalances {
  PoolSideBalance coin;  ///< base vault
  PoolSideBalance pc;    ///< quote vault
};

/// A token account the followed wallet owns in the transaction.
struct UserTokenAccount {
  bool exists = true;
  bool is_ata = true;
  double pre_balance = 0.0;
  double post_balance = 0.0;
  std::uint32_t decimals = 0;
  std::string mint;
};

struct RaydiumSwapData : BaseSwapData {
  static constexpr SwapType kType = SwapType::Raydium;

  /// Lifted straight from the followed wallet's swap instruction, so the copy
  /// needs no pool discovery. The TypeScript build called slot 14
  /// "serumOpenOrders"; it is the OpenBook vault signer.
  pools::PoolAccounts pool;

  /// The followed wallet's own source and destination token accounts (slots
  /// 15 and 16). Kept for the record; the copy uses its own.
  Pubkey leader_source_account;
  Pubkey leader_destination_account;

  std::string token_in_mint;
  std::string token_out_mint;
  std::optional<std::uint32_t> decimals_in;
  std::optional<std::uint32_t> decimals_out;

  PoolBalances pool_balances;
  std::map<std::string, UserTokenAccount> user_accounts;  ///< by account index
  std::string ray_log_data;
  std::uint64_t slot = 0;
};

using ParsedSwap = std::variant<PumpSwapData, RaydiumSwapData>;

const BaseSwapData& base_of(const ParsedSwap& swap);
SwapType type_of(const ParsedSwap& swap);

// --- Monitor state --------------------------------------------------------------

struct MonitorStatus {
  bool is_active = false;
  std::optional<std::chrono::system_clock::time_point> connected_at;
  std::optional<std::chrono::system_clock::time_point> last_transaction_at;
  std::uint64_t processed_transactions = 0;
  std::uint64_t detected_swaps = 0;
  std::uint64_t successful_copies = 0;
  std::uint64_t failed_copies = 0;
};

enum class MonitorErrorType {
  Startup,
  Subscription,
  MaxReconnect,
  Parse,
  Execution,
  Validation,
};
const char* to_string(MonitorErrorType type);

struct MonitorError {
  MonitorErrorType type = MonitorErrorType::Parse;
  std::string message;
  std::string transaction;  ///< signature, when there is one
  std::chrono::system_clock::time_point timestamp;
};

}  // namespace eclipse::copytrade
