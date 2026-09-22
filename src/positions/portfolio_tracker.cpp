#include "eclipse/positions/portfolio_tracker.hpp"

#include <algorithm>
#include <cmath>

#include "eclipse/common/logger.hpp"
#include "eclipse/pools/pool_discovery.hpp"
#include "eclipse/pools/pool_selector.hpp"
#include "eclipse/positions/token_tracker.hpp"
#include "eclipse/solana/programs.hpp"

namespace eclipse::positions {
namespace {

/// Quote size used to read a price off the curve. Small enough that the
/// constant-product impact is negligible, large enough to avoid rounding to
/// zero on a token with few decimals.
constexpr std::uint64_t kPriceProbeLamports = 10000000;  // 0.01 SOL

double lamports_to_sol(std::uint64_t lamports) {
  return static_cast<double>(lamports) /
         static_cast<double>(solana::kLamportsPerSol);
}

}  // namespace

PortfolioTracker& PortfolioTracker::instance() {
  static PortfolioTracker tracker;
  return tracker;
}

void PortfolioTracker::start(net::RpcClient* client, const Pubkey& wallet) {
  if (running_.load()) return;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    client_ = client;
    wallet_ = wallet;
  }

  running_.store(true);
  poll_thread_ = std::thread([this] {
    // The first refresh happens immediately so the Positions screen has data
    // before the first interval elapses.
    refresh();

    while (running_.load()) {
      std::unique_lock<std::mutex> lock(stop_mutex_);
      if (stop_signal_.wait_for(lock, kPollInterval,
                                [this] { return !running_.load(); })) {
        return;
      }
      lock.unlock();
      refresh();
    }
  });

  Logger::instance().success("PortfolioTracker", "Balance polling started");
}

double PortfolioTracker::get_price(const Pubkey& mint) {
  net::RpcClient* client = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    client = client_;
  }
  if (client == nullptr) return 0.0;

  auto pool = pools::discover_pool(*client, solana::native_mint(), mint);
  if (!pool.has_value()) return 0.0;

  auto quote = pools::quote_pool(*client, *pool, kPriceProbeLamports);
  if (!quote.has_value() || quote->expected_output == 0) return 0.0;

  // The probe buys tokens with SOL, so price per token is the inverse of the
  // output ratio, scaled back out of base units.
  const double tokens_out = static_cast<double>(quote->expected_output) /
                            std::pow(10.0, pool->base_mint == mint
                                               ? pool->base_decimals
                                               : pool->quote_decimals);
  if (tokens_out <= 0.0) return 0.0;

  return lamports_to_sol(kPriceProbeLamports) / tokens_out;
}

PortfolioSnapshot PortfolioTracker::refresh() {
  net::RpcClient* client = nullptr;
  Pubkey wallet;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    client = client_;
    wallet = wallet_;
  }
  if (client == nullptr) return cached();

  PortfolioSnapshot snapshot;
  snapshot.taken_at = std::chrono::system_clock::now();

  if (auto lamports = client->get_balance(wallet)) {
    snapshot.sol_balance = lamports_to_sol(*lamports);
  }

  auto token_accounts = client->get_token_accounts_by_owner(wallet);
  if (!token_accounts.has_value()) {
    // A failed poll should leave the previous snapshot in place rather than
    // blanking the screen; 429s here are routine.
    Logger::instance().debug("PortfolioTracker", "Balance poll failed",
                             client->last_error());
    return cached();
  }

  auto& tracker = TokenTracker::instance();

  for (const auto& account : *token_accounts) {
    if (account.amount.ui_amount <= 0.0) continue;

    Position position;
    position.mint = account.mint.to_base58();
    position.symbol = position.mint.substr(0, 4) + "..." +
                      position.mint.substr(position.mint.size() - 4);
    position.balance = account.amount.ui_amount;
    position.decimals = account.amount.decimals;

    // The chain is the authority on how many tokens are held; the tracker is
    // the authority on what they cost.
    tracker.reconcile_balance(position.mint, position.balance);

    if (auto tracked = tracker.get(position.mint)) {
      position.average_entry_price = tracked->average_entry_price;
      position.realized_pnl_sol = tracked->realized_pnl();
    }

    position.current_price = get_price(account.mint);
    position.value_in_sol = position.balance * position.current_price;

    if (position.average_entry_price > 0.0) {
      const double cost = position.balance * position.average_entry_price;
      position.unrealized_pnl_sol = position.value_in_sol - cost;
      if (cost > 0.0) {
        position.unrealized_pnl_percent =
            position.unrealized_pnl_sol / cost * 100.0;
      }
    }

    snapshot.positions_value_sol += position.value_in_sol;
    snapshot.total_unrealized_pnl_sol += position.unrealized_pnl_sol;
    snapshot.total_realized_pnl_sol += position.realized_pnl_sol;
    snapshot.positions.push_back(std::move(position));
  }

  std::sort(snapshot.positions.begin(), snapshot.positions.end(),
            [](const Position& a, const Position& b) {
              return a.value_in_sol > b.value_in_sol;
            });

  snapshot.total_value_sol =
      snapshot.sol_balance + snapshot.positions_value_sol;

  std::vector<UpdateHandler> handlers;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_ = snapshot;
    handlers = handlers_;
  }

  // Handlers run outside the lock: one of them writes to the terminal and
  // another posts a webhook, neither of which should block a poll.
  for (const auto& handler : handlers) handler(snapshot);

  return snapshot;
}

PortfolioSnapshot PortfolioTracker::cached() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return snapshot_;
}

void PortfolioTracker::on_update(UpdateHandler handler) {
  std::lock_guard<std::mutex> lock(mutex_);
  handlers_.push_back(std::move(handler));
}

void PortfolioTracker::stop() {
  if (!running_.load()) return;

  {
    std::lock_guard<std::mutex> lock(stop_mutex_);
    running_.store(false);
  }
  stop_signal_.notify_all();

  if (poll_thread_.joinable()) poll_thread_.join();
  Logger::instance().info("PortfolioTracker", "Balance polling stopped");
}

PortfolioTracker::~PortfolioTracker() { stop(); }

}  // namespace eclipse::positions
