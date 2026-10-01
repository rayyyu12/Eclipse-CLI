#pragma once

#include <string>

namespace eclipse::cli {

void display_menu();

/// Runs the chosen command. Returns false when the user picks Exit.
bool handle_menu_choice(const std::string& choice);

namespace handlers {

void handle_buy();
void handle_sell();
void handle_positions();
void handle_settings();
void handle_balance();
void handle_transfer();

/// The copy trading screen: start and stop following, manage the followed
/// wallets, settings and the live log.
void handle_copy_trade();
void handle_copy_trade_settings();

/// Stops the copy trader's streams and lets in-flight copies finish. Called
/// at shutdown, before the services the copies use are torn down.
void shutdown_copy_trade();

}  // namespace handlers

}  // namespace eclipse::cli
