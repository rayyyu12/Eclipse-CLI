#include "eclipse/orders/order_manager.hpp"

#include <algorithm>

#include "eclipse/common/logger.hpp"
#include "eclipse/positions/portfolio_tracker.hpp"

namespace eclipse::orders {

const char* to_string(OrderKind kind) {
  switch (kind) {
    case OrderKind::StopLoss:   return "stop-loss";
    case OrderKind::TakeProfit: return "take-profit";
    case OrderKind::Limit:      return "limit";
  }
  return "unknown";
}

const char* to_string(OrderState state) {
  switch (state) {
    case OrderState::Active:    return "active";
    case OrderState::Triggered: return "triggered";
    case OrderState::Cancelled: return "cancelled";
    case OrderState::Failed:    return "failed";
  }
  return "unknown";
}

OrderManager& OrderManager::instance() {
  static OrderManager manager;
  return manager;
}

void OrderManager::start(ExecuteHandler handler) {
  if (running_.load()) return;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    handler_ = std::move(handler);
  }

  running_.store(true);
  poll_thread_ = std::thread([this] {
    while (running_.load()) {
      std::unique_lock<std::mutex> lock(stop_mutex_);
      if (stop_signal_.wait_for(lock, kPollInterval,
                                [this] { return !running_.load(); })) {
        return;
      }
      lock.unlock();
      poll();
    }
  });
}

std::string OrderManager::place(OrderKind kind, const Pubkey& mint,
                                double trigger_price, double amount) {
  std::lock_guard<std::mutex> lock(mutex_);

  Order order;
  order.mint = mint.to_base58();
  order.kind = kind;
  order.trigger_price = trigger_price;
  order.amount = amount;
  order.created_at = std::chrono::system_clock::now();
  order.id = order.mint.substr(0, 8) + "-" +
             std::to_string(std::chrono::duration_cast<std::chrono::seconds>(
                                order.created_at.time_since_epoch())
                                .count());

  Logger::instance().info(
      "OrderManager",
      std::string("Placed ") + to_string(kind) + " on " + order.mint + " at " +
          std::to_string(trigger_price));

  orders_.push_back(order);
  return order.id;
}

std::string OrderManager::place_stop_loss(const Pubkey& mint,
                                          double trigger_price,
                                          double amount) {
  return place(OrderKind::StopLoss, mint, trigger_price, amount);
}

std::string OrderManager::place_take_profit(const Pubkey& mint,
                                            double trigger_price,
                                            double amount) {
  return place(OrderKind::TakeProfit, mint, trigger_price, amount);
}

std::string OrderManager::place_limit(const Pubkey& mint, double trigger_price,
                                      double amount) {
  return place(OrderKind::Limit, mint, trigger_price, amount);
}

bool OrderManager::cancel(const std::string& order_id) {
  std::lock_guard<std::mutex> lock(mutex_);

  const auto found = std::find_if(
      orders_.begin(), orders_.end(),
      [&order_id](const Order& order) { return order.id == order_id; });

  if (found == orders_.end() || found->state != OrderState::Active) {
    return false;
  }
  found->state = OrderState::Cancelled;
  return true;
}

bool OrderManager::crossed(const Order& order, double price) {
  if (price <= 0.0) return false;

  switch (order.kind) {
    case OrderKind::StopLoss:
      return price <= order.trigger_price;
    case OrderKind::TakeProfit:
      return price >= order.trigger_price;
    case OrderKind::Limit:
      // A limit buy fills at or below its price.
      return price <= order.trigger_price;
  }
  return false;
}

void OrderManager::poll() {
  // Collect the work under the lock, then run it outside: executing a swap
  // takes seconds and would otherwise block cancel().
  std::vector<Order> due;
  ExecuteHandler handler;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    handler = handler_;
    if (!handler) return;

    for (auto& order : orders_) {
      if (order.state != OrderState::Active) continue;

      auto mint = Pubkey::try_parse(order.mint);
      if (!mint.has_value()) continue;

      const double price = positions::PortfolioTracker::instance().get_price(
          *mint);
      if (!crossed(order, price)) continue;

      // Marked before the swap runs so a slow fill cannot trigger it twice.
      order.state = OrderState::Triggered;
      due.push_back(order);
    }
  }

  for (const auto& order : due) {
    Logger::instance().info("OrderManager",
                            std::string("Triggered ") + to_string(order.kind) +
                                " on " + order.mint);

    const std::string signature = handler(order);

    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = std::find_if(
        orders_.begin(), orders_.end(),
        [&order](const Order& candidate) { return candidate.id == order.id; });
    if (found == orders_.end()) continue;

    if (signature.empty()) {
      found->state = OrderState::Failed;
    } else {
      found->signature = signature;
    }
  }
}

std::vector<Order> OrderManager::active() const {
  std::lock_guard<std::mutex> lock(mutex_);

  std::vector<Order> out;
  std::copy_if(orders_.begin(), orders_.end(), std::back_inserter(out),
               [](const Order& order) {
                 return order.state == OrderState::Active;
               });
  return out;
}

std::vector<Order> OrderManager::all() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return orders_;
}

void OrderManager::stop() {
  if (!running_.load()) return;

  {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    running_.store(false);
  }
  stop_signal_.notify_all();

  if (poll_thread_.joinable()) poll_thread_.join();
}

OrderManager::~OrderManager() { stop(); }

}  // namespace eclipse::orders
