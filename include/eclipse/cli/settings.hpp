#pragma once

#include <mutex>
#include <optional>
#include <string>
#include <vector>

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

/// How the copy trader sizes a buy.
///
///   Fixed   always spends fixed_buy_amount
///   Mirror  spends what the followed wallet spent
enum class BuyMode { Fixed, Mirror };
const char* to_string(BuyMode mode);
BuyMode buy_mode_from_string(const std::string& text);

/// The followed wallets are not here: they live in the encrypted store via
/// WalletStorage, because who a user copies is worth keeping private.
struct CopyTradeSettings {
  BuyMode buy_mode = BuyMode::Fixed;
  double fixed_buy_amount = 0.0001;  ///< SOL
  double min_buy_amount = 0.0;       ///< SOL; a smaller buy is refused
  double max_buy_amount = 100.0;     ///< SOL; a larger buy is refused

  bool enable_pump = true;
  bool enable_raydium = true;

  double pump_slippage = 10.0;     ///< percent
  double raydium_slippage = 50.0;  ///< percent
};

/// Every rule the settings break, empty when they are valid. The checks are
/// the TypeScript build's validateSettings.
std::vector<std::string> validate_copy_trade_settings(
    const CopyTradeSettings& settings);

struct Settings {
  FeeSettings fees;
  TradeSettings trade;
  ConnectionSettings connection;
  NotificationSettings notifications;
  CopyTradeSettings copy_trade;
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

  /// Throws std::invalid_argument, listing every broken rule, and leaves the
  /// stored settings untouched when the new ones do not validate.
  void update_copy_trade(const CopyTradeSettings& copy_trade);

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
