#include <iomanip>
#include <iostream>
#include <sstream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/cli/formatting.hpp"
#include "eclipse/cli/menu.hpp"
#include "eclipse/cli/validation.hpp"
#include "eclipse/net/connection_pool.hpp"
#include "eclipse/positions/portfolio_tracker.hpp"
#include "eclipse/solana/programs.hpp"

namespace eclipse::cli::handlers {
namespace {

using namespace config::colors;

std::string pad(const std::string& text, std::size_t width) {
  if (text.size() >= width) return text.substr(0, width);
  return text + std::string(width - text.size(), ' ');
}

std::string fixed(double value, int places) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(places) << value;
  return out.str();
}

const char* pnl_color(double value) {
  return value >= 0.0 ? kSuccess : kError;
}

}  // namespace

void handle_positions() {
  std::cout << ansi::paint_bold(kPrimary, "Positions") << "\n\n";

  positions::PortfolioSnapshot snapshot;
  {
    Spinner spinner("Reading balances...");
    snapshot = positions::PortfolioTracker::instance().refresh();
    spinner.stop();
  }

  std::cout << ansi::paint(kAccent, "Wallet:    ")
            << format_sol(snapshot.sol_balance) << '\n'
            << ansi::paint(kAccent, "Positions: ")
            << format_sol(snapshot.positions_value_sol) << '\n'
            << ansi::paint(kAccent, "Total:     ")
            << format_sol(snapshot.total_value_sol) << "\n\n";

  if (snapshot.positions.empty()) {
    display_info("No open positions.");
    return;
  }

  std::cout << ansi::paint(kSecondary,
                           pad("TOKEN", 14) + pad("BALANCE", 18) +
                               pad("VALUE", 14) + pad("ENTRY", 14) +
                               pad("PNL", 12) + "PNL %")
            << '\n'
            << ansi::paint(kSecondary, std::string(78, '-')) << '\n';

  for (const auto& position : snapshot.positions) {
    std::cout << pad(shorten(position.mint), 14)
              << pad(fixed(position.balance, 4), 18)
              << pad(fixed(position.value_in_sol, 4), 14)
              << pad(fixed(position.average_entry_price, 8), 14)
              << ansi::paint(pnl_color(position.unrealized_pnl_sol),
                             pad(fixed(position.unrealized_pnl_sol, 4), 12))
              << ansi::paint(pnl_color(position.unrealized_pnl_percent),
                             format_percent(position.unrealized_pnl_percent))
              << '\n';
  }

  std::cout << ansi::paint(kSecondary, std::string(78, '-')) << '\n'
            << ansi::paint(kAccent, "Unrealized: ")
            << ansi::paint(pnl_color(snapshot.total_unrealized_pnl_sol),
                           format_sol(snapshot.total_unrealized_pnl_sol))
            << '\n'
            << ansi::paint(kAccent, "Realized:   ")
            << ansi::paint(pnl_color(snapshot.total_realized_pnl_sol),
                           format_sol(snapshot.total_realized_pnl_sol))
            << '\n';
}

void handle_balance() {
  std::cout << ansi::paint_bold(kPrimary, "Balance") << "\n\n";

  Keypair wallet;
  try {
    wallet = CredentialsManager::instance().get_keypair();
  } catch (const std::exception& error) {
    display_error("Could not load the wallet", error.what());
    return;
  }

  auto& client = net::ConnectionPool::instance().get();

  Spinner spinner("Reading wallet balance...");
  const auto lamports = client.get_balance(wallet.pubkey());
  spinner.stop();

  if (!lamports.has_value()) {
    display_error("Could not read the balance", client.last_error());
    return;
  }

  std::cout << ansi::paint(kAccent, "Address: ") << wallet.pubkey().to_base58()
            << '\n'
            << ansi::paint(kAccent, "Balance: ")
            << format_sol(static_cast<double>(*lamports) /
                          static_cast<double>(solana::kLamportsPerSol))
            << '\n';
}

void handle_transfer() {
  std::cout << ansi::paint_bold(kPrimary, "Transfer") << "\n\n";

  Keypair wallet;
  try {
    wallet = CredentialsManager::instance().get_keypair();
  } catch (const std::exception& error) {
    display_error("Could not load the wallet", error.what());
    return;
  }

  std::string destination_text;
  if (!prompt_validated("Destination address: ", validate_public_key,
                        "That is not a valid address.", destination_text)) {
    return;
  }
  const auto destination = Pubkey::try_parse(destination_text);
  if (!destination.has_value()) return;

  std::string amount_text;
  if (!prompt_validated("Amount in SOL: ", validate_sol_amount,
                        "Enter a positive amount.", amount_text)) {
    return;
  }
  const auto sol = parse_double(amount_text);
  if (!sol.has_value()) return;

  // A transfer is irreversible and the address was typed by hand, so it is
  // read back before anything is signed.
  std::cout << '\n'
            << ansi::paint(kAccent, "Sending ") << format_sol(*sol)
            << ansi::paint(kAccent, " to ") << destination_text << '\n';

  std::string confirmation;
  if (!prompt("Type 'yes' to confirm: ", confirmation) ||
      confirmation != "yes") {
    display_info("Cancelled.");
    return;
  }

  display_warning("Transfers are not implemented in this build.");
}

}  // namespace eclipse::cli::handlers
