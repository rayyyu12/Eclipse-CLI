#include <fstream>
#include <nlohmann/json.hpp>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/logger.hpp"

namespace eclipse::cli {
namespace {

using Json = nlohmann::json;

constexpr const char* kSettingsFile = "settings.json";

template <typename T>
void read_optional(const Json& source, const char* key,
                   std::optional<T>& target) {
  if (source.contains(key) && !source[key].is_null()) {
    target = source[key].get<T>();
  }
}

template <typename T>
void write_optional(Json& target, const char* key,
                    const std::optional<T>& value) {
  if (value.has_value()) target[key] = *value;
}

}  // namespace

const char* to_string(TipAggressiveness level) {
  switch (level) {
    case TipAggressiveness::Low:    return "low";
    case TipAggressiveness::Medium: return "medium";
    case TipAggressiveness::High:   return "high";
  }
  return "medium";
}

TipAggressiveness tip_aggressiveness_from_string(const std::string& text) {
  if (text == "low") return TipAggressiveness::Low;
  if (text == "high") return TipAggressiveness::High;
  return TipAggressiveness::Medium;
}

SettingsManager& SettingsManager::instance() {
  static SettingsManager manager;
  return manager;
}

SettingsManager::SettingsManager() : path_(kSettingsFile) { load(); }

void SettingsManager::load() {
  std::ifstream file(path_);
  if (!file.is_open()) {
    // No file yet: the defaults in the struct definitions stand, and the first
    // write creates one.
    return;
  }

  Json parsed = Json::parse(file, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) {
    Logger::instance().warn("Settings",
                            "Ignoring unreadable " + path_ + "; using defaults");
    return;
  }

  if (parsed.contains("fees")) {
    const auto& fees = parsed["fees"];
    settings_.fees.use_automatic_jito_tip =
        fees.value("useAutomaticJitoTip", true);
    settings_.fees.use_automatic_priority_fee =
        fees.value("useAutomaticPriorityFee", true);
    settings_.fees.jito_tip_aggressiveness = tip_aggressiveness_from_string(
        fees.value("jitoTipAggressiveness", "medium"));
    read_optional(fees, "fixedJitoTipAmount",
                  settings_.fees.fixed_jito_tip_amount);
    read_optional(fees, "fixedPriorityFee", settings_.fees.fixed_priority_fee);
  }

  if (parsed.contains("trade")) {
    const auto& trade = parsed["trade"];
    settings_.trade.buy_slippage = trade.value("buySlippage", 0.5);
    settings_.trade.sell_slippage = trade.value("sellSlippage", 1.0);
  }

  if (parsed.contains("connection")) {
    const auto& connection = parsed["connection"];
    // Blank strings in the file mean "unset" rather than an empty endpoint.
    const auto read_non_empty = [&connection](const char* key,
                                              std::optional<std::string>& out) {
      if (!connection.contains(key) || !connection[key].is_string()) return;
      auto value = connection[key].get<std::string>();
      if (!value.empty()) out = std::move(value);
    };
    read_non_empty("rpcUrl", settings_.connection.rpc_url);
    read_non_empty("grpcUrl", settings_.connection.grpc_url);
    read_non_empty("wsEndpoint", settings_.connection.ws_endpoint);
  }

  if (parsed.contains("notifications")) {
    const auto& notifications = parsed["notifications"];
    settings_.notifications.enable_discord_webhook =
        notifications.value("enableDiscordWebhook", false);
    settings_.notifications.notify_on_trades =
        notifications.value("notifyOnTrades", true);
    settings_.notifications.notify_on_errors =
        notifications.value("notifyOnErrors", true);
    read_optional(notifications, "discordWebhookUrl",
                  settings_.notifications.discord_webhook_url);
  }
}

void SettingsManager::save() const {
  Json fees = {
      {"useAutomaticJitoTip", settings_.fees.use_automatic_jito_tip},
      {"useAutomaticPriorityFee", settings_.fees.use_automatic_priority_fee},
      {"jitoTipAggressiveness",
       to_string(settings_.fees.jito_tip_aggressiveness)}};
  write_optional(fees, "fixedJitoTipAmount",
                 settings_.fees.fixed_jito_tip_amount);
  write_optional(fees, "fixedPriorityFee", settings_.fees.fixed_priority_fee);

  Json connection = Json::object();
  write_optional(connection, "rpcUrl", settings_.connection.rpc_url);
  write_optional(connection, "grpcUrl", settings_.connection.grpc_url);
  write_optional(connection, "wsEndpoint", settings_.connection.ws_endpoint);

  Json notifications = {
      {"enableDiscordWebhook", settings_.notifications.enable_discord_webhook},
      {"notifyOnTrades", settings_.notifications.notify_on_trades},
      {"notifyOnErrors", settings_.notifications.notify_on_errors}};
  write_optional(notifications, "discordWebhookUrl",
                 settings_.notifications.discord_webhook_url);

  const Json out = {
      {"fees", std::move(fees)},
      {"trade",
       {{"buySlippage", settings_.trade.buy_slippage},
        {"sellSlippage", settings_.trade.sell_slippage}}},
      {"connection", std::move(connection)},
      {"notifications", std::move(notifications)}};

  std::ofstream file(path_);
  if (!file.is_open()) {
    Logger::instance().warn("Settings", "Could not write " + path_);
    return;
  }
  file << out.dump(2) << '\n';
}

Settings SettingsManager::get() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return settings_;
}

void SettingsManager::update(const Settings& settings) {
  std::lock_guard<std::mutex> lock(mutex_);
  settings_ = settings;
  save();
}

void SettingsManager::update_fees(const FeeSettings& fees) {
  std::lock_guard<std::mutex> lock(mutex_);
  settings_.fees = fees;
  save();
}

void SettingsManager::update_trade(const TradeSettings& trade) {
  std::lock_guard<std::mutex> lock(mutex_);
  settings_.trade = trade;
  save();
}

void SettingsManager::update_connection(const ConnectionSettings& connection) {
  std::lock_guard<std::mutex> lock(mutex_);
  settings_.connection = connection;
  save();
}

void SettingsManager::update_notifications(
    const NotificationSettings& notifications) {
  std::lock_guard<std::mutex> lock(mutex_);
  settings_.notifications = notifications;
  save();
}

void SettingsManager::reset_to_defaults() {
  std::lock_guard<std::mutex> lock(mutex_);
  settings_ = Settings{};
  save();
}

}  // namespace eclipse::cli
