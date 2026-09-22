#pragma once

#include <chrono>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace eclipse::positions {

enum class TradeSide { Buy, Sell };
const char* to_string(TradeSide side);

struct TokenTransaction {
  TradeSide side = TradeSide::Buy;
  double sol_amount = 0.0;
  double token_amount = 0.0;
  double price_per_token = 0.0;
  std::string signature;
  std::chrono::system_clock::time_point at;

  /// Set on sells only, against the average entry at the time.
  std::optional<double> realized_profit_percent;
};

struct TokenPosition {
  std::string mint;
  double token_balance = 0.0;
  double average_entry_price = 0.0;  ///< SOL per token
  double total_sol_in = 0.0;
  double total_sol_out = 0.0;
  std::vector<TokenTransaction> transactions;

  /// Profit taken so far, in SOL.
  double realized_pnl() const { return total_sol_out - total_sol_in; }

  bool closed() const { return token_balance <= 0.0; }
};

/// Trade history, persisted to token-positions.json.
///
/// Average entry is recomputed from the buy legs on every record, so a partial
/// sell does not distort the cost basis of what is left.
class TokenTracker {
 public:
  static TokenTracker& instance();

  void record_buy(const std::string& mint, double sol_amount,
                  double token_amount, const std::string& signature);

  /// Returns the realized profit percentage against the average entry.
  double record_sell(const std::string& mint, double sol_amount,
                     double token_amount, const std::string& signature);

  std::optional<TokenPosition> get(const std::string& mint) const;
  std::vector<TokenPosition> all(bool include_closed = false) const;

  /// Overwrites the tracked balance with what the chain reports, which is the
  /// authority after a transfer the CLI did not make.
  void reconcile_balance(const std::string& mint, double on_chain_balance);

  void remove(const std::string& mint);
  void clear();
  void flush() const;

 private:
  TokenTracker();

  void load();
  static void recompute_average_entry(TokenPosition& position);

  mutable std::mutex mutex_;
  std::string path_;
  std::unordered_map<std::string, TokenPosition> positions_;
};

}  // namespace eclipse::positions
