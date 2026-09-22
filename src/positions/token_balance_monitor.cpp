#include "eclipse/positions/token_balance_monitor.hpp"

#include "eclipse/common/logger.hpp"
#include "eclipse/positions/token_tracker.hpp"

namespace eclipse::positions {

TokenBalanceMonitor& TokenBalanceMonitor::instance() {
  static TokenBalanceMonitor monitor;
  return monitor;
}

std::optional<double> TokenBalanceMonitor::update(net::RpcClient& client,
                                                  const Pubkey& wallet,
                                                  const Pubkey& mint) {
  const Pubkey account = Pubkey::associated_token_address(wallet, mint);

  auto balance = client.get_token_account_balance(account);
  if (!balance.has_value()) {
    // A missing account is a closed position, not an error: the token program
    // reclaims the account when the last unit leaves it.
    TokenTracker::instance().reconcile_balance(mint.to_base58(), 0.0);
    return std::nullopt;
  }

  TokenTracker::instance().reconcile_balance(mint.to_base58(),
                                             balance->ui_amount);
  return balance->ui_amount;
}

void TokenBalanceMonitor::update_all(net::RpcClient& client,
                                     const Pubkey& wallet) {
  std::lock_guard<std::mutex> lock(mutex_);

  for (const auto& position : TokenTracker::instance().all()) {
    auto mint = Pubkey::try_parse(position.mint);
    if (!mint.has_value()) continue;
    update(client, wallet, *mint);
  }
}

void TokenBalanceMonitor::handle_confirmed_sell(net::RpcClient& client,
                                                const Pubkey& wallet,
                                                const Pubkey& mint) {
  std::lock_guard<std::mutex> lock(mutex_);

  const auto balance = update(client, wallet, mint);
  if (balance.has_value() && *balance > 0.0) return;

  Logger::instance().info("BalanceMonitor",
                          "Position closed: " + mint.to_base58());
}

}  // namespace eclipse::positions
