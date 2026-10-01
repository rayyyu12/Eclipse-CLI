#include <iostream>
#include <sstream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/formatting.hpp"
#include "eclipse/cli/menu.hpp"
#include "eclipse/cli/settings.hpp"
#include "eclipse/cli/validation.hpp"

namespace eclipse::cli::handlers {
namespace {

using namespace config::colors;

std::string number(double value) {
  std::ostringstream out;
  out << value;
  return out.str();
}

void line(const std::string& label, const std::string& value) {
  std::cout << ansi::paint(kAccent, label + ": " + value) << '\n';
}

void row(const char* number, const char* label) {
  std::cout << ansi::paint(kSecondary, std::string(number) + ". ")
            << ansi::paint(kAccent, label) << '\n';
}

/// Validates and saves; the manager refuses settings that break a rule and
/// says which.
void save(const CopyTradeSettings& settings) {
  try {
    SettingsManager::instance().update_copy_trade(settings);
    display_success("Settings updated successfully");
  } catch (const std::exception& error) {
    display_error("Failed to update settings", error.what());
  }
}

/// A non-negative decimal, or nullopt with the error already shown.
std::optional<double> ask_amount(const std::string& question,
                                 bool allow_zero) {
  std::string text;
  if (!prompt(question, text)) return std::nullopt;

  const auto value = parse_double(text);
  if (!value.has_value() || *value < 0.0 || (!allow_zero && *value == 0.0)) {
    display_error("Invalid amount");
    return std::nullopt;
  }
  return value;
}

void change_buy_mode(CopyTradeSettings settings) {
  std::cout << '\n' << ansi::paint(kPrimary, "Available Buy Modes:") << '\n';
  row("1", "Fixed Amount");
  row("2", "Mirror Original");

  std::string choice;
  if (!prompt("\nSelect buy mode: ", choice)) return;

  if (choice == "1") {
    settings.buy_mode = BuyMode::Fixed;
  } else if (choice == "2") {
    settings.buy_mode = BuyMode::Mirror;
  } else {
    display_error("Invalid option");
    return;
  }
  save(settings);
}

void set_slippage(CopyTradeSettings settings) {
  std::cout << '\n' << ansi::paint(kPrimary, "Set Slippage Tolerance:") << '\n';
  row("1", "Set Pump.fun Slippage");
  row("2", "Set Raydium Slippage");

  std::string choice;
  if (!prompt("\nSelect option: ", choice)) return;

  std::string text;
  if (!prompt("Slippage tolerance percentage (0.1-100): ", text)) return;

  const auto percent = parse_double(text);
  if (!percent.has_value() || *percent <= 0.0 || *percent > 100.0) {
    display_error("Invalid percentage");
    return;
  }

  if (choice == "1") {
    settings.pump_slippage = *percent;
  } else if (choice == "2") {
    settings.raydium_slippage = *percent;
  } else {
    display_error("Invalid option");
    return;
  }
  save(settings);
}

void toggle_protocols(CopyTradeSettings settings) {
  std::cout << '\n' << ansi::paint(kPrimary, "Toggle Protocols:") << '\n';
  row("1", settings.enable_pump ? "Pump.fun (Enabled)" : "Pump.fun (Disabled)");
  row("2",
      settings.enable_raydium ? "Raydium (Enabled)" : "Raydium (Disabled)");

  std::string choice;
  if (!prompt("\nSelect protocol to toggle: ", choice)) return;

  if (choice == "1") {
    settings.enable_pump = !settings.enable_pump;
  } else if (choice == "2") {
    settings.enable_raydium = !settings.enable_raydium;
  } else {
    display_error("Invalid option");
    return;
  }
  save(settings);
}

}  // namespace

void handle_copy_trade_settings() {
  auto& manager = SettingsManager::instance();

  while (true) {
    ansi::clear_screen();
    std::cout << ansi::paint_bold(kPrimary, "Copy Trading Settings") << '\n'
              << ansi::paint(kSecondary, std::string(30, '-')) << '\n';

    // Read fresh each time round: a change takes effect on the next copy,
    // running monitor or not, because the executor reads settings per trade.
    const CopyTradeSettings settings = manager.get().copy_trade;

    std::cout << '\n' << ansi::paint(kPrimary, "Buy Settings:") << '\n';
    line("Buy Mode", to_string(settings.buy_mode));
    line("Fixed Buy Amount", number(settings.fixed_buy_amount) + " SOL");

    std::cout << '\n' << ansi::paint(kPrimary, "Filters:") << '\n';
    line("Min Buy Amount", number(settings.min_buy_amount) + " SOL");
    line("Max Buy Amount", number(settings.max_buy_amount) + " SOL");

    std::cout << '\n' << ansi::paint(kPrimary, "Slippage Tolerance:") << '\n';
    line("Pump.fun", number(settings.pump_slippage) + "%");
    line("Raydium", number(settings.raydium_slippage) + "%");

    std::cout << '\n' << ansi::paint(kPrimary, "Enabled Protocols:") << '\n';
    line("Pump.fun", settings.enable_pump ? "Yes" : "No");
    line("Raydium", settings.enable_raydium ? "Yes" : "No");

    std::cout << '\n';
    row("1", "Change Buy Mode");
    row("2", "Set Fixed Buy Amount");
    row("3", "Set Min Buy Amount");
    row("4", "Set Max Buy Amount");
    row("5", "Set Slippage Tolerance");
    row("6", "Toggle Protocols");
    row("7", "Back to Copy Trading Menu");

    std::string choice;
    if (!prompt("\nSelect an option: ", choice)) return;

    if (choice == "1") {
      change_buy_mode(settings);
    } else if (choice == "2") {
      if (auto amount = ask_amount("\nFixed buy amount in SOL: ", false)) {
        auto updated = settings;
        updated.fixed_buy_amount = *amount;
        save(updated);
      }
    } else if (choice == "3") {
      if (auto amount = ask_amount("\nMinimum buy amount in SOL: ", true)) {
        auto updated = settings;
        updated.min_buy_amount = *amount;
        save(updated);
      }
    } else if (choice == "4") {
      if (auto amount = ask_amount("\nMaximum buy amount in SOL: ", false)) {
        auto updated = settings;
        updated.max_buy_amount = *amount;
        save(updated);
      }
    } else if (choice == "5") {
      set_slippage(settings);
    } else if (choice == "6") {
      toggle_protocols(settings);
    } else if (choice == "7") {
      return;
    } else {
      display_error("Invalid option");
    }

    press_enter_to_continue();
  }
}

}  // namespace eclipse::cli::handlers
