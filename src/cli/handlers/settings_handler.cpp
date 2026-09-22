#include <iostream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/cli/formatting.hpp"
#include "eclipse/cli/menu.hpp"
#include "eclipse/cli/settings.hpp"
#include "eclipse/cli/validation.hpp"
#include "eclipse/cli/wallet_storage.hpp"
#include "eclipse/common/logger.hpp"

namespace eclipse::cli::handlers {
namespace {

using namespace config::colors;

void row(const char* number, const std::string& label,
         const std::string& value) {
  std::cout << ansi::paint(kSecondary, std::string(number) + ". ")
            << ansi::paint(kAccent, label);
  if (!value.empty()) {
    std::cout << ansi::paint(kSecondary, "  [" + value + "]");
  }
  std::cout << '\n';
}

std::string state_of(const std::function<std::string()>& getter) {
  try {
    const std::string value = getter();
    return value.empty() ? "not set" : "set";
  } catch (const std::exception&) {
    return "not set";
  }
}

bool ask_yes_no(const std::string& question, bool current) {
  std::string answer;
  if (!prompt(question + (current ? " [Y/n]: " : " [y/N]: "), answer)) {
    return current;
  }
  if (answer.empty()) return current;
  return answer[0] == 'y' || answer[0] == 'Y';
}

void configure_connection() {
  auto& credentials = CredentialsManager::instance();

  std::cout << '\n' << ansi::paint_bold(kPrimary, "Connection") << "\n\n";
  row("1", "RPC URL", state_of([&] { return credentials.get_rpc_url(); }));
  row("2", "Private key",
      state_of([&] { return credentials.get_private_key(); }));
  row("3", "GRPC URL", state_of([&] { return credentials.get_grpc_url(); }));
  row("4", "WebSocket endpoint",
      state_of([&] { return credentials.get_ws_endpoint(); }));
  row("5", "Back", "");

  std::string choice;
  if (!prompt("\nSelect: ", choice)) return;

  try {
    if (choice == "1") {
      std::string url;
      if (!prompt_validated("RPC URL: ", validate_http_url,
                            "Must start with http:// or https://", url)) {
        return;
      }
      Spinner spinner("Checking the endpoint...");
      const bool ok = credentials.validate_rpc_url(url);
      spinner.stop();

      if (!ok) {
        display_error("That endpoint did not answer");
        return;
      }
      credentials.set_rpc_url(url);
      display_success("RPC URL saved");

    } else if (choice == "2") {
      // Read without echo: this is the wallet key.
      std::string key;
      if (!prompt_hidden("Private key (base58, input hidden): ", key)) return;

      if (!credentials.validate_private_key(key)) {
        display_error("That is not a valid base58 ed25519 private key");
        return;
      }
      credentials.set_private_key(key);

      const auto wallet = credentials.get_keypair();
      display_success("Private key saved",
                      "Wallet " + wallet.pubkey().to_base58());

    } else if (choice == "3") {
      std::string url;
      if (!prompt_validated("GRPC URL: ", validate_http_url,
                            "Must start with http:// or https://", url)) {
        return;
      }
      credentials.set_grpc_url(url);
      display_success("GRPC URL saved");

    } else if (choice == "4") {
      std::string url;
      if (!prompt_validated("WebSocket endpoint: ", validate_ws_url,
                            "Must start with ws:// or wss://", url)) {
        return;
      }
      credentials.set_ws_endpoint(url);
      display_success("WebSocket endpoint saved");
    }
  } catch (const std::exception& error) {
    display_error("Could not save that", error.what());
  }
}

void configure_fees() {
  auto& manager = SettingsManager::instance();
  auto settings = manager.get();
  auto& fees = settings.fees;

  std::cout << '\n' << ansi::paint_bold(kPrimary, "Fees") << "\n\n";
  row("1", "Automatic Jito tip", fees.use_automatic_jito_tip ? "on" : "off");
  row("2", "Fixed Jito tip",
      fees.fixed_jito_tip_amount.has_value()
          ? format_sol(*fees.fixed_jito_tip_amount)
          : "not set");
  row("3", "Tip aggressiveness", to_string(fees.jito_tip_aggressiveness));
  row("4", "Automatic priority fee",
      fees.use_automatic_priority_fee ? "on" : "off");
  row("5", "Fixed priority fee",
      fees.fixed_priority_fee.has_value()
          ? std::to_string(*fees.fixed_priority_fee) + " uLamports"
          : "not set");
  row("6", "Back", "");

  std::string choice;
  if (!prompt("\nSelect: ", choice)) return;

  if (choice == "1") {
    fees.use_automatic_jito_tip =
        ask_yes_no("Use automatic Jito tips?", fees.use_automatic_jito_tip);

  } else if (choice == "2") {
    std::string amount;
    if (!prompt_validated("Fixed tip in SOL: ", validate_sol_amount,
                          "Enter a positive amount.", amount)) {
      return;
    }
    fees.fixed_jito_tip_amount = parse_double(amount);

  } else if (choice == "3") {
    std::string level;
    if (!prompt("Aggressiveness (low/medium/high): ", level)) return;
    fees.jito_tip_aggressiveness = tip_aggressiveness_from_string(level);

  } else if (choice == "4") {
    fees.use_automatic_priority_fee = ask_yes_no(
        "Use automatic priority fees?", fees.use_automatic_priority_fee);

  } else if (choice == "5") {
    std::string amount;
    if (!prompt("Fixed priority fee in microLamports: ", amount)) return;
    const auto value = parse_double(amount);
    if (!value.has_value() || *value < 0.0) {
      display_error("Enter a non-negative number");
      return;
    }
    fees.fixed_priority_fee = static_cast<std::uint64_t>(*value);

  } else {
    return;
  }

  manager.update_fees(fees);
  display_success("Fee settings saved");
}

void configure_trade() {
  auto& manager = SettingsManager::instance();
  auto settings = manager.get();
  auto& trade = settings.trade;

  std::cout << '\n' << ansi::paint_bold(kPrimary, "Trading") << "\n\n";
  row("1", "Buy slippage", format_percent(trade.buy_slippage).substr(1));
  row("2", "Sell slippage", format_percent(trade.sell_slippage).substr(1));
  row("3", "Back", "");

  std::string choice;
  if (!prompt("\nSelect: ", choice)) return;

  std::string value;
  if (choice == "1") {
    if (!prompt_validated("Buy slippage percent: ", validate_percentage,
                          "Enter 0 to 100.", value)) {
      return;
    }
    trade.buy_slippage = parse_double(value).value_or(trade.buy_slippage);

  } else if (choice == "2") {
    if (!prompt_validated("Sell slippage percent: ", validate_percentage,
                          "Enter 0 to 100.", value)) {
      return;
    }
    trade.sell_slippage = parse_double(value).value_or(trade.sell_slippage);

  } else {
    return;
  }

  manager.update_trade(trade);
  display_success("Trading settings saved");
}

void configure_notifications() {
  auto& manager = SettingsManager::instance();
  auto settings = manager.get();
  auto& notifications = settings.notifications;

  std::cout << '\n' << ansi::paint_bold(kPrimary, "Notifications") << "\n\n";
  row("1", "Discord webhook",
      notifications.enable_discord_webhook ? "on" : "off");
  row("2", "Webhook URL",
      notifications.discord_webhook_url.has_value() ? "set" : "not set");
  row("3", "Notify on trades", notifications.notify_on_trades ? "on" : "off");
  row("4", "Notify on errors", notifications.notify_on_errors ? "on" : "off");
  row("5", "Back", "");

  std::string choice;
  if (!prompt("\nSelect: ", choice)) return;

  if (choice == "1") {
    notifications.enable_discord_webhook = ask_yes_no(
        "Enable the Discord webhook?", notifications.enable_discord_webhook);

  } else if (choice == "2") {
    std::string url;
    if (!prompt_validated("Webhook URL: ", validate_http_url,
                          "Must start with https://", url)) {
      return;
    }
    notifications.discord_webhook_url = url;

  } else if (choice == "3") {
    notifications.notify_on_trades =
        ask_yes_no("Notify on trades?", notifications.notify_on_trades);

  } else if (choice == "4") {
    notifications.notify_on_errors =
        ask_yes_no("Notify on errors?", notifications.notify_on_errors);

  } else {
    return;
  }

  manager.update_notifications(notifications);
  display_success("Notification settings saved");
}

void configure_wallets() {
  auto& storage = WalletStorage::instance();

  std::cout << '\n' << ansi::paint_bold(kPrimary, "Tracked wallets") << "\n\n";

  const auto wallets = storage.get();
  if (wallets.empty()) {
    display_info("No wallets tracked.");
  } else {
    for (const auto& wallet : wallets) {
      std::cout << "  " << wallet << '\n';
    }
  }

  std::cout << '\n';
  row("1", "Add a wallet", "");
  row("2", "Remove a wallet", "");
  row("3", "Back", "");

  std::string choice;
  if (!prompt("\nSelect: ", choice)) return;

  std::string wallet;
  if (choice == "1") {
    if (!prompt_validated("Address: ", validate_public_key,
                          "That is not a valid address.", wallet)) {
      return;
    }
    if (storage.add(wallet)) {
      display_success("Wallet added");
    } else {
      display_error("Already tracked");
    }

  } else if (choice == "2") {
    if (!prompt("Address: ", wallet)) return;
    if (storage.remove(wallet)) {
      display_success("Wallet removed");
    } else {
      display_error("That wallet was not tracked");
    }
  }
}

void clear_credentials() {
  display_warning("This deletes the stored RPC URL and private key.");

  std::string confirmation;
  if (!prompt("Type 'yes' to confirm: ", confirmation) ||
      confirmation != "yes") {
    display_info("Cancelled.");
    return;
  }

  CredentialsManager::instance().clear();
  display_success("Credentials cleared");
}

}  // namespace

void handle_settings() {
  while (true) {
    ansi::clear_screen();
    std::cout << ansi::paint_bold(kPrimary, "Settings") << "\n\n";

    row("1", "Connection", "");
    row("2", "Fees", "");
    row("3", "Trading", "");
    row("4", "Notifications", "");
    row("5", "Tracked wallets", "");
    row("6", "Clear credentials", "");
    row("7", "Back", "");

    std::string choice;
    if (!prompt("\nSelect: ", choice)) return;

    if (choice == "1")      configure_connection();
    else if (choice == "2") configure_fees();
    else if (choice == "3") configure_trade();
    else if (choice == "4") configure_notifications();
    else if (choice == "5") configure_wallets();
    else if (choice == "6") clear_credentials();
    else if (choice == "7") return;
    else                    display_error("Not a valid option");

    press_enter_to_continue();
  }
}

}  // namespace eclipse::cli::handlers
