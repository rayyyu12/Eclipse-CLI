#include <cmath>
#include <iostream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/cli/formatting.hpp"
#include "eclipse/cli/menu.hpp"
#include "eclipse/cli/settings.hpp"
#include "eclipse/cli/validation.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/net/connection_pool.hpp"
#include "eclipse/pools/token_type_cache.hpp"
#include "eclipse/positions/portfolio_tracker.hpp"
#include "eclipse/positions/report_card.hpp"
#include "eclipse/positions/token_balance_monitor.hpp"
#include "eclipse/positions/token_tracker.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/swaps/pump_swap.hpp"
#include "eclipse/swaps/regular_swap.hpp"

namespace eclipse::cli::handlers {
namespace {
using namespace config::colors;
}

void handle_sell() {
  std::cout << ansi::paint_bold(kPrimary, "Sell") << "\n\n";

  std::string mint_text;
  if (!prompt_validated("Token mint address: ", validate_public_key,
                        "That is not a valid address.", mint_text)) {
    return;
  }
  const auto mint = Pubkey::try_parse(mint_text);
  if (!mint.has_value()) return;

  Keypair wallet;
  try {
    wallet = CredentialsManager::instance().get_keypair();
  } catch (const std::exception& error) {
    display_error("Could not load the wallet", error.what());
    return;
  }

  auto& client = net::ConnectionPool::instance().get();

  // Read the live balance rather than trusting the tracker: a transfer made
  // outside the CLI would make a tracked figure wrong.
  const Pubkey token_account =
      Pubkey::associated_token_address(wallet.pubkey(), *mint);
  const auto balance = client.get_token_account_balance(token_account);

  if (!balance.has_value() || balance->ui_amount <= 0.0) {
    display_error("No balance to sell for that token");
    return;
  }

  std::cout << ansi::paint(kAccent,
                           "Balance: " + std::to_string(balance->ui_amount))
            << "\n\n";

  std::string percent_text;
  if (!prompt_validated("Percentage to sell (0-100): ", validate_percentage,
                        "Enter a number between 0 and 100.", percent_text)) {
    return;
  }
  const auto percent = parse_double(percent_text);
  if (!percent.has_value() || *percent <= 0.0) return;

  const double ui_amount = balance->ui_amount * (*percent / 100.0);
  const auto raw_amount = static_cast<std::uint64_t>(
      std::floor(ui_amount * std::pow(10.0, balance->decimals)));

  if (raw_amount == 0) {
    display_error("That percentage rounds to zero tokens");
    return;
  }

  const auto settings = SettingsManager::instance().get();
  swaps::SwapOptions options;
  options.slippage_percent = settings.trade.sell_slippage;
  options.use_jito = !settings.fees.use_automatic_jito_tip ||
                     settings.fees.fixed_jito_tip_amount.has_value();

  swaps::SwapResult result;
  {
    Spinner spinner("Checking where this token trades...");
    const auto info = pools::TokenTypeCache::instance().check(client, *mint);

    if (info.type == pools::TokenType::Unknown) {
      spinner.fail("No pump.fun curve or Raydium pool for that token");
      return;
    }

    spinner.update("Selling on " +
                   std::string(info.type == pools::TokenType::PumpFun
                                   ? "pump.fun"
                                   : "Raydium") +
                   "...");

    result = info.type == pools::TokenType::PumpFun
                 ? swaps::pump_sell(client, wallet, *mint, raw_amount, options)
                 : swaps::sell_for_sol(client, wallet, *mint, raw_amount,
                                       options);

    if (result.success) {
      spinner.succeed("Filled in " + std::to_string(result.elapsed.count()) +
                      "ms");
    } else {
      spinner.fail("Sell failed");
    }
  }

  if (!result.success) {
    display_error("Order did not complete", result.error);
    if (!result.signature.empty()) {
      display_info("Signature: " + result.signature);
    }
    return;
  }

  const double sol_out = static_cast<double>(result.expected_out) /
                         static_cast<double>(solana::kLamportsPerSol);

  const double profit_percent = positions::TokenTracker::instance().record_sell(
      mint_text, sol_out, ui_amount, result.signature);

  positions::TokenBalanceMonitor::instance().handle_confirmed_sell(
      client, wallet.pubkey(), *mint);

  std::cout << '\n';
  display_success("Sold " + format_percent(*percent).substr(1) + " of " +
                  shorten(mint_text));
  display_info("Received about " + format_sol(sol_out));
  display_info("Realized " + format_percent(profit_percent));
  display_info("Signature: " + result.signature);

  // Posts only when a webhook is configured; it is off by default.
  for (const auto& position :
       positions::PortfolioTracker::instance().cached().positions) {
    if (position.mint != mint_text) continue;
    positions::post_position_card(position, profit_percent);
    break;
  }
}

}  // namespace eclipse::cli::handlers
