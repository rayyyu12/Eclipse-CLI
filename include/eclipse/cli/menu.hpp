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

}  // namespace handlers

}  // namespace eclipse::cli
