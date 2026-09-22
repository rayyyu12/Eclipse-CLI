#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "eclipse/common/keypair.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::positions {

/// A position as shown on the Positions screen: tracked cost basis joined
/// with the live on-chain balance and price.
struct Position {
  std::string mint;
  std::string symbol;

  double balance = 0.0;
  int decimals = 0;

  double average_entry_price = 0.0;  ///< SOL per token
  double current_price = 0.0;        ///< SOL per token
  double value_in_sol = 0.0;

  double unrealized_pnl_sol = 0.0;
  double unrealized_pnl_percent = 0.0;
  double realized_pnl_sol = 0.0;
};

struct PortfolioSnapshot {
  double sol_balance = 0.0;
  double positions_value_sol = 0.0;
  double total_value_sol = 0.0;
  double total_unrealized_pnl_sol = 0.0;
  double total_realized_pnl_sol = 0.0;
  std::vector<Position> positions;
  std::chrono::system_clock::time_point taken_at;
};

/// Watches wallet balances in the background and joins them with the trade
/// history to produce positions.
///
/// The TypeScript build subscribed to account changes over a websocket. This
/// polls on an interval instead: it is one dependency fewer, and the providers
/// that rate-limit hardest are the ones whose websockets drop anyway.
class PortfolioTracker {
 public:
  using UpdateHandler = std::function<void(const PortfolioSnapshot&)>;

  static PortfolioTracker& instance();

  /// Starts the poller. Safe to call more than once.
  void start(net::RpcClient* client, const Pubkey& wallet);

  /// Reads balances now rather than waiting for the next poll.
  PortfolioSnapshot refresh();

  /// Last snapshot taken, without touching the network.
  PortfolioSnapshot cached() const;

  /// Live price for one mint, in SOL, quoted from its pool.
  double get_price(const Pubkey& mint);

  void on_update(UpdateHandler handler);

  void stop();
  ~PortfolioTracker();

 private:
  PortfolioTracker() = default;

  static constexpr auto kPollInterval = std::chrono::seconds(20);

  mutable std::mutex mutex_;
  net::RpcClient* client_ = nullptr;
  Pubkey wallet_;
  PortfolioSnapshot snapshot_;
  std::vector<UpdateHandler> handlers_;

  std::atomic<bool> running_{false};
  std::thread poll_thread_;
  std::condition_variable stop_signal_;
  std::mutex stop_mutex_;
};

}  // namespace eclipse::positions
