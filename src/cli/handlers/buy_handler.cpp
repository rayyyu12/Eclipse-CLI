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
#include "eclipse/pools/pool_selector.hpp"
#include "eclipse/pools/token_type_cache.hpp"
#include "eclipse/positions/token_tracker.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/swaps/pump_swap.hpp"
#include "eclipse/swaps/regular_swap.hpp"

namespace eclipse::cli::handlers {
namespace {
using namespace config::colors;
}

void handle_buy() {
  std::cout << ansi::paint_bold(kPrimary, "Buy") << "\n\n";

  std::string mint_text;
  if (!prompt_validated("Token mint address: ", validate_public_key,
                        "That is not a valid address.", mint_text)) {
    return;
  }
  const auto mint = Pubkey::try_parse(mint_text);
  if (!mint.has_value()) return;

  std::string amount_text;
  if (!prompt_validated("Amount in SOL: ", validate_sol_amount,
                        "Enter a positive amount.", amount_text)) {
    return;
  }
  const auto sol = parse_double(amount_text);
  if (!sol.has_value()) return;

  const auto lamports = static_cast<std::uint64_t>(
      *sol * static_cast<double>(solana::kLamportsPerSol));

  auto& client = net::ConnectionPool::instance().get();
  const auto settings = SettingsManager::instance().get();

  swaps::SwapOptions options;
  options.slippage_percent = settings.trade.buy_slippage;
  options.use_jito = !settings.fees.use_automatic_jito_tip ||
                     settings.fees.fixed_jito_tip_amount.has_value();

  Keypair wallet;
  try {
    wallet = CredentialsManager::instance().get_keypair();
  } catch (const std::exception& error) {
    display_error("Could not load the wallet", error.what());
    return;
  }

  swaps::SwapResult result;
  {
    Spinner spinner("Checking where this token trades...");

    // Pump.fun tokens graduate to Raydium, so the venue is resolved per order
    // rather than assumed.
    const auto info = pools::TokenTypeCache::instance().check(client, *mint);

    if (info.type == pools::TokenType::Unknown) {
      spinner.fail("No pump.fun curve or Raydium pool for that token");
      return;
    }

    spinner.update(std::string("Buying on ") +
                   (info.type == pools::TokenType::PumpFun ? "pump.fun"
                                                           : "Raydium") +
                   "...");

    result = info.type == pools::TokenType::PumpFun
                 ? swaps::pump_buy(client, wallet, *mint, lamports, options)
                 : swaps::buy_with_sol(client, wallet, *mint, lamports,
                                       options);

    if (result.success) {
      spinner.succeed("Filled in " + std::to_string(result.elapsed.count()) +
                      "ms");
    } else {
      spinner.fail("Buy failed");
    }
  }

  if (!result.success) {
    display_error("Order did not complete", result.error);
    if (!result.signature.empty()) {
      display_info("Signature: " + result.signature);
    }
    return;
  }

  // Recorded against the expected output: the exact fill is only knowable by
  // parsing the confirmed transaction, and the next balance poll corrects it.
  const double tokens = static_cast<double>(result.expected_out);
  positions::TokenTracker::instance().record_buy(mint_text, *sol, tokens,
                                                 result.signature);

  std::cout << '\n';
  display_success("Bought " + format_sol(*sol) + " of " + shorten(mint_text));
  display_info("Signature: " + result.signature);
  display_info("Priority fee: " +
               std::to_string(result.priority_fee_micro_lamports) +
               " microLamports");
  if (result.jito_tip_lamports > 0) {
    display_info("Jito tip: " +
                 format_sol(static_cast<double>(result.jito_tip_lamports) /
                            static_cast<double>(solana::kLamportsPerSol)));
  }
}

}  // namespace eclipse::cli::handlers
