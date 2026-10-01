#include <atomic>
#include <csignal>
#include <iostream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/cli/formatting.hpp"
#include "eclipse/cli/menu.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/net/connection_pool.hpp"
#include "eclipse/orders/order_manager.hpp"
#include "eclipse/pools/persistent_pool_cache.hpp"
#include "eclipse/positions/portfolio_tracker.hpp"
#include "eclipse/positions/token_tracker.hpp"
#include "eclipse/swaps/blockhash_manager.hpp"

namespace {

using namespace eclipse;

std::atomic<bool> g_shutting_down{false};

void shutdown() {
  if (g_shutting_down.exchange(true)) return;

  auto& logger = Logger::instance();
  logger.info("App", "Shutting down");

  // Stop the background threads before the singletons they read start being
  // torn down. The copy trader goes first: its in-flight copies use all of
  // the services below.
  cli::handlers::shutdown_copy_trade();
  positions::PortfolioTracker::instance().stop();
  orders::OrderManager::instance().stop();
  swaps::BlockhashManager::instance().cleanup();
  net::ConnectionPool::instance().cleanup();

  pools::PersistentPoolCache::instance().flush();
  positions::TokenTracker::instance().flush();

  logger.success("App", "Clean shutdown");
}

void handle_signal(int) {
  // Only async-signal-safe work belongs here, so this just sets the flag and
  // lets the main loop exit; the terminal may be mid-prompt.
  g_shutting_down.store(true);
  std::_Exit(0);
}

/// Brings up the connection pool, blockhash refresher and portfolio poller.
/// Each failure is reported and stepped over: the menu should still open so
/// the user can reach Settings and fix whatever is wrong.
bool initialize_services() {
  auto& logger = Logger::instance();
  auto& credentials = cli::CredentialsManager::instance();

  if (!credentials.has_credentials()) {
    logger.warn("App", "No credentials configured");

    std::cout << ansi::paint(config::colors::kPrimary,
                             "\nNo credentials found. Configure them first:\n"
                             "  1. Go to Settings\n"
                             "  2. Set the RPC URL\n"
                             "  3. Set the private key\n")
              << '\n';
    return false;
  }

  try {
    net::ConnectionPool::instance().initialize();
    logger.success("App", "Connection pool ready");
  } catch (const std::exception& error) {
    logger.warn("App", "Connection pool failed to start", error.what());
    cli::display_warning(
        "Connection pool unavailable; some features will be limited.");
    return false;
  }

  try {
    swaps::BlockhashManager::instance().initialize(
        &net::ConnectionPool::instance().get());
  } catch (const std::exception& error) {
    logger.warn("App", "Blockhash manager failed to start", error.what());
  }

  try {
    const auto wallet = credentials.get_keypair();
    positions::PortfolioTracker::instance().start(
        &net::ConnectionPool::instance().get(), wallet.pubkey());
  } catch (const std::exception& error) {
    logger.warn("App", "Portfolio tracking failed to start", error.what());
    cli::display_warning("Position tracking unavailable.");
  }

  return true;
}

}  // namespace

int main() {
  std::signal(SIGINT, handle_signal);
  std::signal(SIGTERM, handle_signal);

  Logger::Options log_options;
  log_options.log_level = LogLevel::Info;
  log_options.log_to_file = true;
  // The menu owns the screen, so log lines would scribble over it.
  log_options.log_to_console = false;
  Logger::instance().initialize(log_options);

  Logger::instance().info("App", "Eclipse CLI starting");

  initialize_services();

  bool running = true;
  while (running) {
    cli::display_menu();

    std::string choice;
    if (!cli::prompt("Select an option: ", choice)) break;  // EOF

    try {
      running = cli::handle_menu_choice(choice);
    } catch (const std::exception& error) {
      // One failed command should not end the session.
      Logger::instance().error("App", "Command failed", error.what());
      cli::display_error("Something went wrong", error.what());
      cli::press_enter_to_continue();
    }
  }

  shutdown();
  return 0;
}
