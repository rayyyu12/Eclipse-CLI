#pragma once

#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "eclipse/common/pubkey.hpp"

namespace eclipse::net {

using Json = nlohmann::json;

enum class Commitment { Processed, Confirmed, Finalized };
const char* to_string(Commitment commitment);

struct BlockhashInfo {
  std::string blockhash;
  std::uint64_t last_valid_block_height = 0;
};

struct AccountInfo {
  Pubkey owner;
  std::uint64_t lamports = 0;
  std::vector<std::uint8_t> data;
  bool executable = false;
};

struct TokenAmount {
  std::string amount;  ///< raw, as a decimal string; can exceed 2^53
  int decimals = 0;
  double ui_amount = 0.0;
};

struct TokenAccount {
  Pubkey address;
  Pubkey mint;
  TokenAmount amount;
};

struct ProgramAccount {
  Pubkey address;
  std::vector<std::uint8_t> data;
};

struct MemcmpFilter {
  std::size_t offset = 0;
  std::string bytes_base58;
};

/// A Solana JSON-RPC endpoint. Errors surface as std::nullopt with the reason
/// in last_error(); the CLI treats a failed call as a retry, not a crash.
class RpcClient {
 public:
  explicit RpcClient(std::string endpoint,
                     Commitment commitment = Commitment::Confirmed);

  const std::string& endpoint() const { return endpoint_; }
  const std::string& last_error() const { return last_error_; }

  std::optional<BlockhashInfo> get_latest_blockhash();
  std::optional<std::uint64_t> get_balance(const Pubkey& address);
  std::optional<AccountInfo> get_account_info(const Pubkey& address);
  std::optional<std::uint64_t> get_block_height();

  std::optional<TokenAmount> get_token_account_balance(const Pubkey& account);
  std::optional<std::vector<TokenAccount>> get_token_accounts_by_owner(
      const Pubkey& owner);

  std::optional<std::vector<ProgramAccount>> get_program_accounts(
      const Pubkey& program_id, std::optional<std::size_t> data_size,
      const std::vector<MemcmpFilter>& filters);

  /// Returns the signature on success.
  std::optional<std::string> send_transaction(
      const std::vector<std::uint8_t>& wire_transaction, bool skip_preflight,
      int max_retries = 3);

  std::optional<Json> simulate_transaction(
      const std::vector<std::uint8_t>& wire_transaction);

  /// nullopt when the signature is unknown; the string is the confirmation
  /// status ("processed", "confirmed", "finalized"), or "failed" on error.
  std::optional<std::string> get_signature_status(const std::string& signature);

  /// Helius extension. Falls back to the caller's default when unsupported.
  std::optional<std::uint64_t> get_priority_fee_estimate(
      const std::vector<std::uint8_t>& wire_transaction);

  /// Escape hatch for calls without a typed wrapper.
  std::optional<Json> call(const std::string& method, const Json& params);

 private:
  std::string endpoint_;
  Commitment commitment_;
  std::string last_error_;
  std::uint64_t request_id_ = 0;
};

}  // namespace eclipse::net
