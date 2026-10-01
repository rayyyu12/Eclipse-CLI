#pragma once

#include <chrono>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

#include "eclipse/net/rpc_client.hpp"

namespace eclipse::pools {

enum class TokenType { Unknown, PumpFun, Raydium };
const char* to_string(TokenType type);

struct TokenTypeInfo {
  TokenType type = TokenType::Unknown;
  bool has_raydium_pool = false;
  std::chrono::system_clock::time_point checked_at;

  /// Pump.fun tokens graduate to Raydium, so a stale answer routes the swap to
  /// the wrong program. Entries expire after an hour.
  bool expired() const;
};

/// Remembers which venue a mint trades on, so the buy and sell paths do not
/// re-probe both programs on every order.
class TokenTypeCache {
 public:
  static TokenTypeCache& instance();

  std::optional<TokenTypeInfo> get(const std::string& mint) const;
  void set(const std::string& mint, TokenType type, bool has_raydium_pool);

  /// Cached when fresh, otherwise probes pump.fun then Raydium.
  TokenTypeInfo check(net::RpcClient& client, const Pubkey& mint);

  void clear();
  void flush() const;

 private:
  TokenTypeCache();

  void load();
  TokenTypeInfo probe(net::RpcClient& client, const Pubkey& mint);

  mutable std::mutex mutex_;
  std::string path_;
  std::unordered_map<std::string, TokenTypeInfo> cache_;
};

/// The bonding curve PDA for a pump.fun mint, and whether it still exists.
/// A missing or completed curve means the token has graduated to Raydium.
struct BondingCurveState {
  Pubkey address;
  std::uint64_t virtual_token_reserves = 0;
  std::uint64_t virtual_sol_reserves = 0;
  std::uint64_t real_token_reserves = 0;
  std::uint64_t real_sol_reserves = 0;
  bool complete = false;
};

std::optional<Pubkey> derive_bonding_curve(const Pubkey& mint);
std::optional<BondingCurveState> fetch_bonding_curve(net::RpcClient& client,
                                                     const Pubkey& mint);

/// Reads a curve whose address the caller has already derived. One round
/// trip, no program-address search.
std::optional<BondingCurveState> fetch_bonding_curve_at(
    net::RpcClient& client, const Pubkey& curve_address);

}  // namespace eclipse::pools
