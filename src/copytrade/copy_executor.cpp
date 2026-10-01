#include "eclipse/copytrade/copy_executor.hpp"

#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>

#include "eclipse/cli/credentials_manager.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/copytrade/copy_swap.hpp"
#include "eclipse/copytrade/copy_trade_logger.hpp"
#include "eclipse/net/connection_pool.hpp"
#include "eclipse/positions/token_balance_monitor.hpp"
#include "eclipse/positions/token_tracker.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/swaps/regular_swap.hpp"

namespace eclipse::copytrade {
namespace {

/// pump.fun mints all use six decimals; the TypeScript build assumed it too.
constexpr int kPumpTokenDecimals = 6;

/// The Raydium path's fallback when the followed wallet's token account does
/// not say (`userToken?.decimals || 6`).
constexpr int kDefaultTokenDecimals = 6;

std::string fixed(double value, int places) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(places) << value;
  return out.str();
}

std::string format_ms(std::chrono::microseconds elapsed) {
  return fixed(static_cast<double>(elapsed.count()) / 1000.0, 2) + "ms";
}

double lamports_to_sol(std::uint64_t lamports) {
  return static_cast<double>(lamports) /
         static_cast<double>(solana::kLamportsPerSol);
}

std::chrono::milliseconds since(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);
}

/// One feed line per stage, in order, starting at `first`. These are the
/// per-stage timings the copy trader is demonstrated with.
void log_stages(const std::string& protocol,
                const std::vector<swaps::StageTiming>& stages,
                std::size_t first) {
  auto& feed = CopyTradeLogger::instance();
  for (std::size_t i = first; i < stages.size(); ++i) {
    feed.add(CopyLogType::Info, protocol,
             stages[i].name + ": " + format_ms(stages[i].elapsed));
  }
}

/// The token decimals the Raydium path sizes a sell with: the followed
/// wallet's own account for the mint, else 6.
int raydium_token_decimals(const RaydiumSwapData& swap) {
  const std::string mint = swap.token_address.to_base58();
  for (const auto& [index, account] : swap.user_accounts) {
    if (account.mint == mint && account.decimals > 0) {
      return static_cast<int>(account.decimals);
    }
  }
  return kDefaultTokenDecimals;
}

/// How much of a token the wallet holds, for a sell. The tracked position is
/// read first because it is local; pump.fun falls back to the chain when
/// nothing is tracked, Raydium refuses. That asymmetry is the TypeScript
/// build's.
std::optional<double> holding_to_sell(net::RpcClient& client,
                                      const Keypair& wallet,
                                      const Pubkey& mint, bool chain_fallback,
                                      std::string& error) {
  const auto tracked =
      positions::TokenTracker::instance().get(mint.to_base58());
  if (tracked.has_value() && tracked->token_balance > 0.0) {
    return tracked->token_balance;
  }

  if (!chain_fallback) {
    error = "No token position found for selling";
    return std::nullopt;
  }

  const auto balance = client.get_token_account_balance(
      Pubkey::associated_token_address(wallet.pubkey(), mint));
  if (!balance.has_value() || balance->ui_amount <= 0.0) {
    error = "No tokens available to sell";
    return std::nullopt;
  }
  return balance->ui_amount;
}

}  // namespace

std::optional<std::uint64_t> resolve_buy_lamports(
    const cli::CopyTradeSettings& settings, double followed_amount_sol,
    std::string* error) {
  const double sol = settings.buy_mode == cli::BuyMode::Fixed
                         ? settings.fixed_buy_amount
                         : followed_amount_sol;

  const auto reject = [&](const std::string& reason) {
    if (error != nullptr) *error = reason;
    return std::nullopt;
  };

  if (sol < settings.min_buy_amount) {
    return reject("Buy amount " + fixed(sol, 9) + " SOL below minimum " +
                  fixed(settings.min_buy_amount, 9) + " SOL");
  }
  if (sol > settings.max_buy_amount) {
    return reject("Buy amount " + fixed(sol, 9) + " SOL above maximum " +
                  fixed(settings.max_buy_amount, 9) + " SOL");
  }

  const double lamports =
      std::round(sol * static_cast<double>(solana::kLamportsPerSol));
  if (lamports < 1.0) return reject("Buy amount rounds to zero lamports");
  return static_cast<std::uint64_t>(lamports);
}

std::uint64_t to_raw_amount(double ui_amount, int decimals) {
  const double raw = std::floor(ui_amount * std::pow(10.0, decimals));
  return raw > 0.0 ? static_cast<std::uint64_t>(raw) : 0;
}

// --- Executor -----------------------------------------------------------------------

struct CopyExecutor::PendingCopy {
  ParsedSwap swap;
  swaps::SwapResult result;
  swaps::StageTimer timer;
  std::chrono::steady_clock::time_point started;
  double sol_amount = 0.0;    ///< SOL spent, on a buy
  double tokens_sold = 0.0;   ///< UI units, on a sell
  int token_decimals = kDefaultTokenDecimals;
  OutcomeHandler on_done;
};

CopyExecutor& CopyExecutor::instance() {
  static CopyExecutor executor;
  return executor;
}

void CopyExecutor::start() { start(Options{}); }

void CopyExecutor::start(const Options& options) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (running_.load()) return;

  // Throws when no key is configured; the caller reports it.
  wallet_ = cli::CredentialsManager::instance().get_keypair();
  options_ = options;

  send_pool_ = std::make_unique<WorkerPool>(options_.send_workers);
  confirmation_pool_ =
      std::make_unique<WorkerPool>(options_.confirmation_workers);
  running_.store(true);

  Logger::instance().info("CopyExecutor",
                          "Started with " +
                              std::to_string(options_.send_workers) +
                              " send worker(s)");
}

void CopyExecutor::stop() {
  // Send workers first, with the confirmation pool still in place: a copy
  // they are finishing will still queue its confirmation.
  std::unique_ptr<WorkerPool> send_pool;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_.exchange(false)) return;
    send_pool = std::move(send_pool_);
  }
  send_pool->shutdown();

  std::unique_ptr<WorkerPool> confirmation_pool;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    confirmation_pool = std::move(confirmation_pool_);
  }
  confirmation_pool->shutdown();

  Logger::instance().info("CopyExecutor", "Stopped");
}

CopyExecutor::~CopyExecutor() { stop(); }

std::string CopyExecutor::wallet_address() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return wallet_.pubkey().to_base58();
}

void CopyExecutor::submit(ParsedSwap swap,
                          std::chrono::steady_clock::time_point received_at,
                          OutcomeHandler on_done) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_.load() || !send_pool_) return;

  send_pool_->submit([this, swap = std::move(swap), received_at,
                      on_done = std::move(on_done)] {
    execute(swap, received_at, on_done);
  });
}

void CopyExecutor::execute(const ParsedSwap& swap,
                           std::chrono::steady_clock::time_point received_at,
                           const OutcomeHandler& on_done) {
  const auto started = std::chrono::steady_clock::now();

  // The timer starts when the transaction came off the stream, so the first
  // stage covers decoding, filtering and the queue.
  swaps::StageTimer timer(received_at);
  timer.mark("Dispatch");

  const BaseSwapData& base = base_of(swap);
  const SwapType type = type_of(swap);
  const std::string protocol = to_string(type);
  const std::string side = base.is_buy ? "BUY" : "SELL";
  const std::string token = base.token_address.to_base58();
  auto& feed = CopyTradeLogger::instance();

  Outcome outcome;
  outcome.protocol = type;
  outcome.is_buy = base.is_buy;
  outcome.token_address = token;
  outcome.original_signature = base.signature;

  const auto fail = [&](const std::string& reason,
                        const std::string& copy_signature = {}) {
    outcome.success = false;
    outcome.error = reason;
    outcome.copy_signature = copy_signature;
    outcome.execution_time = since(started);

    feed.add(CopyLogType::Error, protocol,
             "Copy trade failed in " +
                 std::to_string(outcome.execution_time.count()) + "ms: " +
                 reason,
             {{"originalTx", base.signature},
              {"type", side},
              {"tokenAddress", token},
              {"signature", copy_signature}});
    if (on_done) on_done(outcome);
  };

  try {
    const auto settings = cli::SettingsManager::instance().get().copy_trade;
    if (type == SwapType::Pump && !settings.enable_pump) {
      return fail("Pump.fun trading is disabled in settings");
    }
    if (type == SwapType::Raydium && !settings.enable_raydium) {
      return fail("Raydium trading is disabled in settings");
    }

    feed.add(CopyLogType::Info, protocol,
             "Executing " + side + " on " + protocol,
             {{"originalTx", base.signature}, {"tokenAddress", token}});

    net::RpcClient& client = net::ConnectionPool::instance().get();

    PendingCopy pending;
    pending.swap = swap;
    pending.started = started;
    pending.on_done = on_done;

    std::string error;

    if (const auto* pump = std::get_if<PumpSwapData>(&swap)) {
      pending.token_decimals = kPumpTokenDecimals;

      if (pump->is_buy) {
        const auto lamports =
            resolve_buy_lamports(settings, pump->amount_in, &error);
        if (!lamports.has_value()) return fail(error);

        pending.sol_amount = lamports_to_sol(*lamports);
        feed.add(CopyLogType::Info, protocol,
                 "Buying with " + fixed(pending.sol_amount, 9) + " SOL",
                 {{"tokenAddress", token}});

        pending.result = copy_pump_buy(client, wallet_, *pump, *lamports,
                                       settings.pump_slippage, timer);
      } else {
        const auto holding = holding_to_sell(
            client, wallet_, pump->token_address, true, error);
        if (!holding.has_value()) return fail(error);

        pending.tokens_sold = *holding;
        feed.add(CopyLogType::Info, protocol,
                 "Selling " + fixed(*holding, 6) + " tokens",
                 {{"tokenAddress", token}});

        pending.result = copy_pump_sell(
            client, wallet_, *pump, to_raw_amount(*holding, kPumpTokenDecimals),
            settings.pump_slippage, timer);
      }
    } else {
      const auto& raydium = std::get<RaydiumSwapData>(swap);
      pending.token_decimals = raydium_token_decimals(raydium);

      if (raydium.is_buy) {
        const auto lamports =
            resolve_buy_lamports(settings, raydium.amount_in, &error);
        if (!lamports.has_value()) return fail(error);

        pending.sol_amount = lamports_to_sol(*lamports);
        feed.add(CopyLogType::Info, protocol,
                 "Buying with " + fixed(pending.sol_amount, 9) + " SOL",
                 {{"tokenAddress", token}});

        pending.result = copy_raydium_swap(wallet_, raydium, *lamports,
                                           settings.raydium_slippage, timer);
      } else {
        const auto holding = holding_to_sell(
            client, wallet_, raydium.token_address, false, error);
        if (!holding.has_value()) return fail(error);

        pending.tokens_sold = *holding;
        feed.add(CopyLogType::Info, protocol,
                 "Selling " + fixed(*holding, 6) + " tokens",
                 {{"tokenAddress", token}});

        // A sell always goes token to WSOL, whatever the followed trade's
        // balance deltas suggested.
        RaydiumSwapData sell = raydium;
        sell.token_in_mint = token;
        sell.token_out_mint = solana::native_mint().to_base58();

        pending.result = copy_raydium_swap(
            wallet_, sell, to_raw_amount(*holding, pending.token_decimals),
            settings.raydium_slippage, timer);
      }
    }

    if (!pending.result.success) {
      return fail(pending.result.error, pending.result.signature);
    }

    // The hot path is done. Report it now rather than after confirmation, so
    // the send latency shows up the moment it is known.
    pending.timer = timer;
    log_stages(protocol, timer.stages(), 0);
    feed.add(CopyLogType::Info, protocol,
             "Sent in " + format_ms(timer.total()) + "; awaiting confirmation",
             {{"signature", pending.result.signature},
              {"originalTx", base.signature}});

    std::lock_guard<std::mutex> lock(mutex_);
    if (confirmation_pool_) {
      confirmation_pool_->submit(
          [this, pending = std::move(pending)]() mutable {
            confirm(std::move(pending));
          });
    }
  } catch (const std::exception& exception) {
    fail(exception.what());
  }
}

void CopyExecutor::confirm(PendingCopy pending) {
  const BaseSwapData& base = base_of(pending.swap);
  const SwapType type = type_of(pending.swap);
  const std::string protocol = to_string(type);
  const std::string token = base.token_address.to_base58();
  const std::string& signature = pending.result.signature;
  auto& feed = CopyTradeLogger::instance();

  Outcome outcome;
  outcome.protocol = type;
  outcome.is_buy = base.is_buy;
  outcome.token_address = token;
  outcome.original_signature = base.signature;
  outcome.copy_signature = signature;

  try {
    net::RpcClient& client = net::ConnectionPool::instance().get();

    // pump.fun copies were confirmed at "processed" in the TypeScript build,
    // Raydium copies at the connection's default ("confirmed").
    const net::Commitment level = type == SwapType::Pump
                                      ? net::Commitment::Processed
                                      : net::Commitment::Confirmed;
    const bool confirmed = swaps::await_confirmation(
        client, signature, options_.confirmation_timeout, level);
    pending.timer.mark("Confirmation");
    log_stages(protocol, pending.timer.stages(),
               pending.timer.stages().size() - 1);

    outcome.execution_time = since(pending.started);

    if (!confirmed) {
      outcome.error = "transaction failed on chain or was not confirmed in time";
      feed.add(CopyLogType::Error, protocol,
               "Copy trade failed in " +
                   std::to_string(outcome.execution_time.count()) + "ms: " +
                   outcome.error,
               {{"signature", signature}, {"originalTx", base.signature}});
      if (pending.on_done) pending.on_done(outcome);
      return;
    }

    // Book the position. This is after the fact and off the hot path.
    auto& tracker = positions::TokenTracker::instance();
    const Pubkey wallet = wallet_.pubkey();
    if (base.is_buy) {
      const double expected = static_cast<double>(pending.result.expected_out) /
                              std::pow(10.0, pending.token_decimals);
      const auto tracked = tracker.get(token);
      const double before = tracked.has_value() ? tracked->token_balance : 0.0;

      const auto after = client.get_token_account_balance(
          Pubkey::associated_token_address(wallet, base.token_address));
      double received = after.has_value() ? after->ui_amount - before : 0.0;
      if (received <= 0.0) received = expected;

      tracker.record_buy(token, pending.sol_amount, received, signature);
      if (after.has_value()) tracker.reconcile_balance(token, after->ui_amount);
    } else {
      const double sol_out = lamports_to_sol(pending.result.expected_out);
      tracker.record_sell(token, sol_out, pending.tokens_sold, signature);
      positions::TokenBalanceMonitor::instance().handle_confirmed_sell(
          client, wallet, base.token_address);
    }

    outcome.success = true;
    feed.add(CopyLogType::Success, protocol,
             "Copy trade successful in " +
                 std::to_string(outcome.execution_time.count()) + "ms",
             {{"signature", signature},
              {"originalTx", base.signature},
              {"type", base.is_buy ? "BUY" : "SELL"},
              {"tokenAddress", token},
              {"explorer", "https://solscan.io/tx/" + signature}});
    feed.add(CopyLogType::Info, protocol,
             "Total: " + format_ms(pending.timer.total()));
  } catch (const std::exception& exception) {
    outcome.error = exception.what();
    outcome.execution_time = since(pending.started);
    feed.add(CopyLogType::Error, protocol,
             "Confirmation failed: " + outcome.error,
             {{"signature", signature}});
  }

  if (pending.on_done) pending.on_done(outcome);
}

}  // namespace eclipse::copytrade
