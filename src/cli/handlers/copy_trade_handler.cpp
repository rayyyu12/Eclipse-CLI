#include <ctime>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/cli/formatting.hpp"
#include "eclipse/cli/menu.hpp"
#include "eclipse/cli/validation.hpp"
#include "eclipse/cli/wallet_storage.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/copytrade/balance_monitor.hpp"
#include "eclipse/copytrade/copy_executor.hpp"
#include "eclipse/copytrade/copy_trade_logger.hpp"
#include "eclipse/copytrade/transaction_monitor.hpp"
#include "eclipse/net/connection_pool.hpp"
#include "eclipse/positions/portfolio_tracker.hpp"
#include "eclipse/positions/report_card.hpp"
#include "eclipse/swaps/blockhash_manager.hpp"

namespace eclipse::cli::handlers {
namespace {

using namespace config::colors;
using copytrade::CopyLogType;
using copytrade::CopyTradeLogger;

constexpr const char* kModule = "CopyTradeHandler";

// The running monitors (activeMonitor in the TypeScript build). Owned here
// because the CLI is what starts and stops them.
std::unique_ptr<copytrade::TransactionMonitor> g_monitor;
std::unique_ptr<copytrade::BalanceMonitor> g_balance_monitor;

std::string format_time(std::chrono::system_clock::time_point tp) {
  const std::time_t t = std::chrono::system_clock::to_time_t(tp);
  std::tm tm{};
#if defined(_WIN32)
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  std::ostringstream out;
  out << std::put_time(&tm, "%Y-%m-%d %H:%M:%S");
  return out.str();
}

std::string fixed(double value, int places) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(places) << value;
  return out.str();
}

void row(const char* number, const char* label) {
  std::cout << ansi::paint(kSecondary, std::string(number) + ". ")
            << ansi::paint(kAccent, label) << '\n';
}

void info_line(const std::string& text) {
  std::cout << ansi::paint(kAccent, text) << '\n';
}

bool monitor_active() { return g_monitor && g_monitor->status().is_active; }

void stop_monitors() {
  g_monitor.reset();          // stops the stream; copies in flight finish
  g_balance_monitor.reset();
}

// --- Status ----------------------------------------------------------------------

void show_status() {
  if (monitor_active()) {
    const auto status = g_monitor->status();
    std::cout << ansi::paint(kPrimary, "Monitor Status: ACTIVE") << '\n';
    info_line("Transactions Processed: " +
              std::to_string(status.processed_transactions));
    info_line("Swaps Detected: " + std::to_string(status.detected_swaps));
    info_line("Copies: " + std::to_string(status.successful_copies) +
              " succeeded, " + std::to_string(status.failed_copies) +
              " failed");
    if (status.last_transaction_at.has_value()) {
      info_line("Last Activity: " + format_time(*status.last_transaction_at));
    }

    if (g_balance_monitor && g_balance_monitor->active()) {
      std::cout << '\n' << ansi::paint(kPrimary, "Wallet Balances:") << '\n';
      for (const auto& [wallet, balance] : g_balance_monitor->balances()) {
        std::string text = shorten(wallet) + "  " + fixed(balance.sol, 9) +
                           " SOL";
        if (balance.updated_at.has_value()) {
          text += "  (updated " + format_time(*balance.updated_at) + ")";
        }
        info_line(text);
      }
    }
  } else {
    std::cout << ansi::paint(kError, "Monitor Status: INACTIVE") << '\n';
  }

  // The poller's last snapshot: no network on a screen redraw.
  const auto snapshot = positions::PortfolioTracker::instance().cached();
  double cost = 0.0;
  for (const auto& position : snapshot.positions) {
    cost += position.balance * position.average_entry_price;
  }

  std::cout << '\n' << ansi::paint(kPrimary, "Portfolio Status:") << '\n';
  info_line("Tracked Positions: " + std::to_string(snapshot.positions.size()));
  info_line("Total Value: " + fixed(snapshot.positions_value_sol, 6) + " SOL");
  info_line("Total PnL: " + fixed(snapshot.total_unrealized_pnl_sol, 6) +
            " SOL" +
            (cost > 0.0
                 ? " (" +
                       format_percent(snapshot.total_unrealized_pnl_sol /
                                      cost * 100.0) +
                       ")"
                 : ""));

  const auto wallets = WalletStorage::instance().get();
  if (wallets.empty()) {
    std::cout << '\n'
              << ansi::paint(kWarning, "No wallets currently monitored")
              << '\n';
  } else {
    std::cout << '\n' << ansi::paint(kPrimary, "Monitored Wallets:") << '\n';
    for (const auto& wallet : wallets) info_line("  " + wallet);
  }
}

// --- Start and stop ----------------------------------------------------------------

/// Brings up whatever the copy path reads from that main() could not start,
/// typically because credentials were entered during this session.
net::RpcClient* ensure_services(const Keypair& wallet) {
  auto& pool = net::ConnectionPool::instance();
  try {
    if (!pool.initialized()) pool.initialize();
  } catch (const std::exception& error) {
    display_error("Could not connect to the RPC endpoint", error.what());
    return nullptr;
  }
  net::RpcClient* client = &pool.get();

  // The copy swaps read the cached blockhash and never fetch one themselves.
  auto& blockhashes = swaps::BlockhashManager::instance();
  if (!blockhashes.initialized()) blockhashes.initialize(client);

  // Sells size themselves from tracked positions.
  positions::PortfolioTracker::instance().start(client, wallet.pubkey());
  return client;
}

void start_monitoring() {
  if (monitor_active()) {
    display_warning("Monitor is already running!");
    return;
  }

  const auto stored = WalletStorage::instance().get();
  if (stored.empty()) {
    display_warning("Please add at least one wallet to monitor first!");
    return;
  }

  auto& credentials = CredentialsManager::instance();
  if (!credentials.has_credentials()) {
    display_error("Please configure the RPC URL and private key in Settings "
                  "first!");
    return;
  }

  std::string grpc_url;
  try {
    grpc_url = credentials.get_grpc_url();
  } catch (const std::exception& error) {
    display_error("Set a GRPC URL in Settings first", error.what());
    return;
  }

  // The x-token is optional: some endpoints authorise by IP or URL instead.
  std::string x_token;
  try {
    x_token = credentials.get_auth_token();
  } catch (const std::exception&) {
  }

  Keypair wallet;
  try {
    wallet = credentials.get_keypair();
  } catch (const std::exception& error) {
    display_error("Could not load the wallet", error.what());
    return;
  }

  display_info("Initializing portfolio tracking...");
  net::RpcClient* client = ensure_services(wallet);
  if (client == nullptr) return;

  const std::vector<std::string> wallets(stored.begin(), stored.end());

  Spinner spinner("Connecting to the gRPC stream...");

  // The balance panel is a convenience; failing to start it does not stop
  // copy trading.
  try {
    g_balance_monitor = std::make_unique<copytrade::BalanceMonitor>(
        copytrade::BalanceMonitor::Config{grpc_url, x_token,
                                          net::Commitment::Processed, wallets});
    g_balance_monitor->start(*client);
  } catch (const std::exception& error) {
    Logger::instance().warn(kModule, "Balance monitor setup failed",
                            error.what());
    g_balance_monitor.reset();
  }

  copytrade::TransactionMonitor::Config config;
  config.grpc_endpoint = grpc_url;
  config.x_token = x_token;
  config.commitment = net::Commitment::Processed;
  config.wallets = wallets;
  // Both venues are always subscribed; the settings' per-venue switches are
  // read at execution time, so toggling one needs no resubscribe.
  config.enable_pump = true;
  config.enable_raydium = true;

  g_monitor = std::make_unique<copytrade::TransactionMonitor>(config);

  g_monitor->on_swap([](const copytrade::ParsedSwap& swap) {
    const auto& base = copytrade::base_of(swap);
    CopyTradeLogger::instance().add(CopyLogType::Info, copytrade::to_string(copytrade::type_of(swap)),
             std::string("Swap detected: ") + (base.is_buy ? "BUY " : "SELL ") +
                 base.token_address.to_base58(),
             {{"amountIn", fixed(base.amount_in, 9)},
              {"originalTx", base.signature}});
  });

  g_monitor->on_error([](const copytrade::MonitorError& error) {
    Logger::instance().warn("TransactionMonitor", to_string(error.type),
                            error.message);
    // Copy failures are already in the feed with their detail.
    if (error.type != copytrade::MonitorErrorType::Execution) {
      CopyTradeLogger::instance().add(CopyLogType::Error, "system",
               std::string("Transaction Monitor Error: ") + error.message);
    }
  });

  try {
    g_monitor->start();
  } catch (const std::exception& error) {
    spinner.fail("Failed to start monitor");
    display_error("Could not start monitoring", error.what());
    stop_monitors();
    return;
  }

  spinner.succeed("Monitor started successfully!");
  display_info("Copies run in the background. View Logs shows them live.");
}

void stop_monitoring() {
  if (!monitor_active()) {
    display_warning("Monitor is not running!");
    return;
  }
  stop_monitors();
  display_success("Monitor stopped successfully!");
}

// --- Wallets ---------------------------------------------------------------------

void add_wallet() {
  std::string address;
  if (!prompt("Enter wallet address to monitor: ", address)) return;

  if (!validate_public_key(address)) {
    display_error("Failed to add wallet", "Invalid Solana wallet address format");
    return;
  }
  if (!WalletStorage::instance().add(address)) {
    display_info("Wallet already monitored: " + address);
    return;
  }

  if (monitor_active()) {
    try {
      Spinner spinner("Resubscribing with the new wallet...");
      g_monitor->add_wallet(address);
      spinner.stop();
    } catch (const std::exception& error) {
      Logger::instance().warn(kModule, "Failed to add wallet to active monitor",
                              error.what());
      display_warning("Wallet added to storage but not to the active monitor. "
                      "You may need to restart monitoring.");
    }
  }
  display_success("Added wallet: " + address);
}

void remove_wallet() {
  const auto wallets = WalletStorage::instance().get();
  if (wallets.empty()) {
    display_warning("No wallets to remove!");
    return;
  }

  std::string address;
  if (!prompt("Enter wallet address to remove: ", address)) return;

  if (wallets.count(address) == 0) {
    display_warning("Wallet not found in monitored list!");
    return;
  }
  WalletStorage::instance().remove(address);

  if (monitor_active()) {
    try {
      Spinner spinner("Resubscribing without the wallet...");
      g_monitor->remove_wallet(address);
      spinner.stop();
    } catch (const std::exception& error) {
      Logger::instance().warn(kModule,
                              "Failed to remove wallet from active monitor",
                              error.what());
      display_warning("Wallet removed from storage but not from the active "
                      "monitor. You may need to restart monitoring.");
    }
  }
  display_success("Removed wallet: " + address);
}

// --- Logs and export -----------------------------------------------------------------

void render_logs() {
  ansi::clear_screen();
  std::cout << ansi::paint_bold(kPrimary, "Copy Trade Logs") << '\n'
            << ansi::paint(kSecondary, std::string(30, '-')) << '\n';

  const auto logs = CopyTradeLogger::instance().get(50);
  if (logs.empty()) {
    std::cout << '\n' << ansi::paint(kWarning, "No logs available") << '\n';
  } else {
    for (const auto& log : logs) {
      std::cout << CopyTradeLogger::format(log) << '\n';
    }
  }

  std::cout << '\n';
  row("1", "Stop Auto-Update");
  row("2", "Clear Logs");
  row("3", "Back to Copy Trading Menu");
}

void view_logs() {
  auto& feed = CopyTradeLogger::instance();
  render_logs();

  // New entries are printed as they arrive while the prompt waits, which is
  // the live view the TypeScript build had.
  const int listener = feed.subscribe([](const copytrade::CopyTradeLog& log) {
    std::cout << '\n' << CopyTradeLogger::format(log) << std::flush;
  });

  while (true) {
    std::string choice;
    if (!prompt("\nSelect an option: ", choice)) break;

    if (choice == "1" || choice == "3") break;
    if (choice == "2") {
      feed.clear();
      render_logs();
      continue;
    }
    display_error("Invalid option");
  }

  feed.unsubscribe(listener);
}

void export_portfolio() {
  std::cout << '\n'
            << ansi::paint(kPrimary, "Exporting Portfolio to Discord...")
            << '\n';

  const auto snapshot = positions::PortfolioTracker::instance().cached();
  if (snapshot.positions.empty()) {
    display_info("No positions to export");
    press_enter_to_continue();
    return;
  }

  std::size_t exported = 0;
  for (const auto& position : snapshot.positions) {
    if (positions::post_position_card(position,
                                      position.unrealized_pnl_percent)) {
      ++exported;
      display_success("Exported position for " + position.symbol);
    }
  }

  if (exported == 0) {
    display_info("Nothing was posted. Is the Discord webhook on under "
                 "Settings > Notifications?");
  }
  press_enter_to_continue();
}

}  // namespace

void handle_copy_trade() {
  while (true) {
    ansi::clear_screen();
    std::cout << ansi::paint_bold(kPrimary, "Copy Trading Menu") << '\n'
              << ansi::paint(kSecondary, std::string(30, '-')) << '\n';

    show_status();

    std::cout << '\n';
    row("1", "Start Monitoring");
    row("2", "Stop Monitoring");
    row("3", "Add Wallet to Monitor");
    row("4", "Remove Wallet");
    row("5", "Copy Trade Settings");
    row("6", "View Logs");
    row("7", "Export Portfolio");
    row("8", "Back to Main Menu");

    std::string choice;
    if (!prompt("\nSelect an option: ", choice)) return;

    bool pause = true;
    try {
      if (choice == "1") {
        start_monitoring();
      } else if (choice == "2") {
        stop_monitoring();
      } else if (choice == "3") {
        add_wallet();
      } else if (choice == "4") {
        remove_wallet();
      } else if (choice == "5") {
        handle_copy_trade_settings();
        pause = false;
      } else if (choice == "6") {
        view_logs();
        pause = false;
      } else if (choice == "7") {
        export_portfolio();
        pause = false;
      } else if (choice == "8") {
        // Leaving the screen stops following, as it did in the TypeScript
        // build. The connection pool, blockhash refresher and portfolio
        // poller are app-wide here, so they keep running.
        stop_monitors();
        CopyTradeLogger::instance().add(
            CopyLogType::Info, "system",
            "Exiting copy trade menu, monitoring stopped");
        return;
      } else {
        display_error("Invalid option");
      }
    } catch (const std::exception& error) {
      Logger::instance().error(kModule, "Error handling option " + choice,
                               error.what());
      display_error("Error", error.what());
    }

    if (pause) press_enter_to_continue();
  }
}

void shutdown_copy_trade() {
  stop_monitors();
  copytrade::CopyExecutor::instance().stop();
}

}  // namespace eclipse::cli::handlers
