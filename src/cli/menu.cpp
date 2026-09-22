#include "eclipse/cli/menu.hpp"

#include <iostream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/cli/formatting.hpp"

namespace eclipse::cli {
namespace {

using namespace config::colors;

/// Reports a missing prerequisite instead of letting the handler fail with an
/// exception the user cannot act on.
bool require_rpc() {
  try {
    CredentialsManager::instance().get_rpc_url();
    return true;
  } catch (const std::exception&) {
    display_error("Set an RPC URL in Settings first");
    return false;
  }
}

bool require_private_key() {
  try {
    CredentialsManager::instance().get_private_key();
    return true;
  } catch (const std::exception&) {
    display_error("Set a private key in Settings first");
    return false;
  }
}

bool require_copy_trade() {
  bool ok = true;
  auto& credentials = CredentialsManager::instance();

  try {
    credentials.get_rpc_url();
  } catch (const std::exception&) {
    display_error("Set an RPC URL in Settings");
    ok = false;
  }
  try {
    credentials.get_grpc_url();
  } catch (const std::exception&) {
    display_error("Set a GRPC URL in Settings");
    ok = false;
  }
  return ok;
}

void print_row(const char* number, const char* label) {
  std::cout << ansi::paint(kSecondary, std::string(number) + ". ")
            << ansi::paint(kAccent, label) << '\n';
}

}  // namespace

void display_menu() {
  ansi::clear_screen();

  std::cout << ansi::paint_bold(kLogo, config::kAsciiBanner) << '\n';
  std::cout << ansi::paint(kSecondary,
                           std::string(config::kMenuWidth, '-'))
            << '\n';

  print_row("1", "Buy");
  print_row("2", "Sell");
  print_row("3", "Positions");
  print_row("4", "Balance");
  print_row("5", "Transfer");
  print_row("6", "Copy Trade");
  print_row("7", "Settings");
  print_row("8", "Exit");

  std::cout << ansi::paint(kSecondary,
                           std::string(config::kMenuWidth, '-'))
            << '\n';
}

bool handle_menu_choice(const std::string& choice) {
  ansi::clear_screen();

  if (choice == config::command::kBuy) {
    if (require_rpc() && require_private_key()) handlers::handle_buy();

  } else if (choice == config::command::kSell) {
    if (require_rpc() && require_private_key()) handlers::handle_sell();

  } else if (choice == config::command::kPositions) {
    if (require_private_key()) handlers::handle_positions();

  } else if (choice == config::command::kBalance) {
    if (require_private_key()) handlers::handle_balance();

  } else if (choice == config::command::kTransfer) {
    if (require_private_key()) handlers::handle_transfer();

  } else if (choice == config::command::kCopyTrade) {
    if (require_copy_trade()) {
      display_info("Copy trading is a premium feature.");
    }

  } else if (choice == config::command::kSettings) {
    handlers::handle_settings();

  } else if (choice == config::command::kExit) {
    std::cout << ansi::paint(kSuccess, "Goodbye.") << '\n';
    return false;

  } else {
    display_error("Not a valid option");
  }

  press_enter_to_continue();
  return true;
}

}  // namespace eclipse::cli
