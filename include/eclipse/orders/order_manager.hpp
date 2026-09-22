#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "eclipse/common/pubkey.hpp"

namespace eclipse::orders {

enum class OrderKind { StopLoss, TakeProfit, Limit };
enum class OrderState { Active, Triggered, Cancelled, Failed };

const char* to_string(OrderKind kind);
const char* to_string(OrderState state);

struct Order {
  std::string id;
  std::string mint;
  OrderKind kind = OrderKind::StopLoss;
  OrderState state = OrderState::Active;

  double trigger_price = 0.0;  ///< SOL per token
  double amount = 0.0;         ///< tokens

  std::chrono::system_clock::time_point created_at;
  std::string signature;  ///< set once the order fires
};

/// Client-side conditional orders.
///
/// Nothing here is on-chain: the CLI watches prices and submits a market swap
/// when one crosses. An order only exists while the process is running, which
/// is why they are not persisted.
class OrderManager {
 public:
  /// Called when an order's trigger is crossed. Returns the signature of the
  /// swap it submitted, or an empty string on failure.
  using ExecuteHandler = std::function<std::string(const Order&)>;

  static OrderManager& instance();

  void start(ExecuteHandler handler);

  std::string place_stop_loss(const Pubkey& mint, double trigger_price,
                              double amount);
  std::string place_take_profit(const Pubkey& mint, double trigger_price,
                                double amount);
  std::string place_limit(const Pubkey& mint, double trigger_price,
                          double amount);

  bool cancel(const std::string& order_id);

  std::vector<Order> active() const;
  std::vector<Order> all() const;

  void stop();
  ~OrderManager();

 private:
  OrderManager() = default;

  std::string place(OrderKind kind, const Pubkey& mint, double trigger_price,
                    double amount);
  void poll();
  static bool crossed(const Order& order, double price);

  static constexpr auto kPollInterval = std::chrono::seconds(10);

  mutable std::mutex mutex_;
  std::vector<Order> orders_;
  ExecuteHandler handler_;

  std::atomic<bool> running_{false};
  std::thread poll_thread_;
  std::condition_variable stop_signal_;
  std::mutex stop_mutex_;
};

}  // namespace eclipse::orders
