#pragma once

#include <mutex>
#include <optional>
#include <string>
#include <unordered_set>

#include "eclipse/common/pubkey.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::positions {

/// Keeps tracked balances honest against the chain.
///
/// After a sell confirms, the balance the tracker believes and the balance the
/// chain reports can disagree, because the fill may be partial. This reads the
/// token account and writes the truth back.
class TokenBalanceMonitor {
 public:
  static TokenBalanceMonitor& instance();

  /// Reads one mint's balance and reconciles it. nullopt when the account does
  /// not exist, which means the position is closed.
  std::optional<double> update(net::RpcClient& client, const Pubkey& wallet,
                               const Pubkey& mint);

  /// Reconciles every open position.
  void update_all(net::RpcClient& client, const Pubkey& wallet);

  /// Called after a sell confirms. Reconciles, and removes the position when
  /// the balance has reached zero.
  void handle_confirmed_sell(net::RpcClient& client, const Pubkey& wallet,
                             const Pubkey& mint);

 private:
  TokenBalanceMonitor() = default;

  mutable std::mutex mutex_;
};

}  // namespace eclipse::positions
