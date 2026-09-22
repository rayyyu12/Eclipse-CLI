#pragma once

#include <mutex>
#include <optional>
#include <string>

namespace eclipse::cli {

enum class TipAggressiveness { Low, Medium, High };
const char* to_string(TipAggressiveness level);
TipAggressiveness tip_aggressiveness_from_string(const std::string& text);

struct FeeSettings {
  bool use_automatic_jito_tip = true;
  std::optional<double> fixed_jito_tip_amount;   ///< SOL
  bool use_automatic_priority_fee = true;
  std::optional<std::uint64_t> fixed_priority_fee;  ///< microLamports
  TipAggressiveness jito_tip_aggressiveness = TipAggressiveness::Medium;
};

struct TradeSettings {
  double buy_slippage = 0.5;   ///< percent
  double sell_slippage = 1.0;  ///< percent
};

struct ConnectionSettings {
  std::optional<std::string> rpc_url;
  std::optional<std::string> grpc_url;
  std::optional<std::string> ws_endpoint;
  // The private key and auth token live in the encrypted store, never here.
};

struct NotificationSettings {
  bool enable_discord_webhook = false;
  std::optional<std::string> discord_webhook_url;
  bool notify_on_trades = true;
  bool notify_on_errors = true;
};

struct Settings {
  FeeSettings fees;
  TradeSettings trade;
  ConnectionSettings connection;
  NotificationSettings notifications;
};

/// Reads and writes settings.json next to the binary. Plain JSON: nothing
/// secret belongs in here.
class SettingsManager {
 public:
  static SettingsManager& instance();

  Settings get() const;

  void update(const Settings& settings);
  void update_fees(const FeeSettings& fees);
  void update_trade(const TradeSettings& trade);
  void update_connection(const ConnectionSettings& connection);
  void update_notifications(const NotificationSettings& notifications);

  void reset_to_defaults();

 private:
  SettingsManager();

  void load();
  void save() const;

  mutable std::mutex mutex_;
  std::string path_;
  Settings settings_;
};

}  // namespace eclipse::cli
