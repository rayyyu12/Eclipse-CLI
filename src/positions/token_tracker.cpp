#include "eclipse/positions/token_tracker.hpp"

#include <algorithm>
#include <fstream>
#include <nlohmann/json.hpp>

#include "eclipse/common/logger.hpp"

namespace eclipse::positions {
namespace {

using Json = nlohmann::json;

constexpr const char* kPositionsFile = "token-positions.json";

std::int64_t to_epoch(std::chrono::system_clock::time_point tp) {
  return std::chrono::duration_cast<std::chrono::seconds>(
             tp.time_since_epoch())
      .count();
}

std::chrono::system_clock::time_point from_epoch(std::int64_t seconds) {
  return std::chrono::system_clock::time_point(
      std::chrono::seconds(seconds));
}

}  // namespace

const char* to_string(TradeSide side) {
  return side == TradeSide::Buy ? "buy" : "sell";
}

TokenTracker& TokenTracker::instance() {
  static TokenTracker tracker;
  return tracker;
}

TokenTracker::TokenTracker() : path_(kPositionsFile) { load(); }

void TokenTracker::load() {
  std::ifstream file(path_);
  if (!file.is_open()) return;

  Json parsed = Json::parse(file, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) {
    Logger::instance().warn("TokenTracker",
                            "Ignoring unreadable positions file " + path_);
    return;
  }

  for (const auto& [mint, entry] : parsed.items()) {
    TokenPosition position;
    position.mint = mint;
    position.token_balance = entry.value("tokenBalance", 0.0);
    position.average_entry_price = entry.value("averageEntryPrice", 0.0);
    position.total_sol_in = entry.value("totalSolIn", 0.0);
    position.total_sol_out = entry.value("totalSolOut", 0.0);

    if (entry.contains("transactions") && entry["transactions"].is_array()) {
      for (const auto& tx : entry["transactions"]) {
        TokenTransaction transaction;
        transaction.side = tx.value("type", "buy") == "sell" ? TradeSide::Sell
                                                             : TradeSide::Buy;
        transaction.sol_amount = tx.value("solAmount", 0.0);
        transaction.token_amount = tx.value("tokenAmount", 0.0);
        transaction.price_per_token = tx.value("pricePerToken", 0.0);
        transaction.signature = tx.value("signature", "");
        transaction.at = from_epoch(tx.value("timestamp", std::int64_t{0}));

        if (tx.contains("profitPercent") && tx["profitPercent"].is_number()) {
          transaction.realized_profit_percent =
              tx["profitPercent"].get<double>();
        }
        position.transactions.push_back(std::move(transaction));
      }
    }
    positions_.emplace(mint, std::move(position));
  }

  Logger::instance().debug(
      "TokenTracker",
      "Loaded " + std::to_string(positions_.size()) + " position(s)");
}

void TokenTracker::flush() const {
  Json out = Json::object();

  for (const auto& [mint, position] : positions_) {
    Json transactions = Json::array();
    for (const auto& tx : position.transactions) {
      Json entry = {{"type", to_string(tx.side)},
                    {"solAmount", tx.sol_amount},
                    {"tokenAmount", tx.token_amount},
                    {"pricePerToken", tx.price_per_token},
                    {"signature", tx.signature},
                    {"timestamp", to_epoch(tx.at)}};
      if (tx.realized_profit_percent.has_value()) {
        entry["profitPercent"] = *tx.realized_profit_percent;
      }
      transactions.push_back(std::move(entry));
    }

    out[mint] = {{"tokenBalance", position.token_balance},
                 {"averageEntryPrice", position.average_entry_price},
                 {"totalSolIn", position.total_sol_in},
                 {"totalSolOut", position.total_sol_out},
                 {"transactions", std::move(transactions)}};
  }

  std::ofstream file(path_);
  if (!file.is_open()) {
    Logger::instance().warn("TokenTracker",
                            "Could not write positions to " + path_);
    return;
  }
  file << out.dump(2) << '\n';
}

void TokenTracker::recompute_average_entry(TokenPosition& position) {
  // Averaged over the buy legs only. Including sells would move the cost basis
  // every time profit is taken, which is not what an entry price means.
  double sol = 0.0;
  double tokens = 0.0;

  for (const auto& tx : position.transactions) {
    if (tx.side != TradeSide::Buy) continue;
    sol += tx.sol_amount;
    tokens += tx.token_amount;
  }

  position.average_entry_price = tokens > 0.0 ? sol / tokens : 0.0;
}

void TokenTracker::record_buy(const std::string& mint, double sol_amount,
                              double token_amount,
                              const std::string& signature) {
  if (token_amount <= 0.0) return;

  std::lock_guard<std::mutex> lock(mutex_);
  auto& position = positions_[mint];
  position.mint = mint;

  TokenTransaction transaction;
  transaction.side = TradeSide::Buy;
  transaction.sol_amount = sol_amount;
  transaction.token_amount = token_amount;
  transaction.price_per_token = sol_amount / token_amount;
  transaction.signature = signature;
  transaction.at = std::chrono::system_clock::now();

  position.transactions.push_back(std::move(transaction));
  position.token_balance += token_amount;
  position.total_sol_in += sol_amount;
  recompute_average_entry(position);

  flush();
}

double TokenTracker::record_sell(const std::string& mint, double sol_amount,
                                 double token_amount,
                                 const std::string& signature) {
  if (token_amount <= 0.0) return 0.0;

  std::lock_guard<std::mutex> lock(mutex_);
  auto found = positions_.find(mint);
  if (found == positions_.end()) return 0.0;

  auto& position = found->second;

  const double exit_price = sol_amount / token_amount;
  double profit_percent = 0.0;
  if (position.average_entry_price > 0.0) {
    profit_percent =
        (exit_price - position.average_entry_price) /
        position.average_entry_price * 100.0;
  }

  TokenTransaction transaction;
  transaction.side = TradeSide::Sell;
  transaction.sol_amount = sol_amount;
  transaction.token_amount = token_amount;
  transaction.price_per_token = exit_price;
  transaction.signature = signature;
  transaction.at = std::chrono::system_clock::now();
  transaction.realized_profit_percent = profit_percent;

  position.transactions.push_back(std::move(transaction));
  position.token_balance = std::max(0.0, position.token_balance - token_amount);
  position.total_sol_out += sol_amount;

  flush();
  return profit_percent;
}

std::optional<TokenPosition> TokenTracker::get(const std::string& mint) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto found = positions_.find(mint);
  if (found == positions_.end()) return std::nullopt;
  return found->second;
}

std::vector<TokenPosition> TokenTracker::all(bool include_closed) const {
  std::lock_guard<std::mutex> lock(mutex_);

  std::vector<TokenPosition> out;
  out.reserve(positions_.size());
  for (const auto& [mint, position] : positions_) {
    if (!include_closed && position.closed()) continue;
    out.push_back(position);
  }

  std::sort(out.begin(), out.end(),
            [](const TokenPosition& a, const TokenPosition& b) {
              return a.total_sol_in > b.total_sol_in;
            });
  return out;
}

void TokenTracker::reconcile_balance(const std::string& mint,
                                     double on_chain_balance) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto found = positions_.find(mint);
  if (found == positions_.end()) return;

  if (found->second.token_balance != on_chain_balance) {
    Logger::instance().debug(
        "TokenTracker",
        "Reconciling " + mint + ": tracked " +
            std::to_string(found->second.token_balance) + ", on-chain " +
            std::to_string(on_chain_balance));
    found->second.token_balance = on_chain_balance;
    flush();
  }
}

void TokenTracker::remove(const std::string& mint) {
  std::lock_guard<std::mutex> lock(mutex_);
  positions_.erase(mint);
  flush();
}

void TokenTracker::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  positions_.clear();
  flush();
}

}  // namespace eclipse::positions
