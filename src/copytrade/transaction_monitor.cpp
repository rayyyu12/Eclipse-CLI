#include "eclipse/copytrade/transaction_monitor.hpp"

#include <stdexcept>

#include "eclipse/cli/formatting.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/copytrade/copy_executor.hpp"
#include "eclipse/copytrade/transaction_parser.hpp"
#include "eclipse/swaps/constants.hpp"

namespace eclipse::copytrade {
namespace {

constexpr const char* kModule = "TransactionMonitor";

}  // namespace

std::vector<TransactionFilter> build_transaction_filters(
    const std::vector<std::string>& wallets, bool enable_pump,
    bool enable_raydium) {
  std::vector<std::string> programs;
  if (enable_pump) programs.push_back(swaps::pump_fun_program_id().to_base58());
  if (enable_raydium) {
    programs.push_back(swaps::raydium_amm_program_id().to_base58());
  }

  std::vector<TransactionFilter> filters;
  if (programs.empty()) return filters;

  filters.reserve(wallets.size());
  for (const auto& wallet : wallets) {
    TransactionFilter filter;
    filter.name = "swapTransactions:" + wallet;
    filter.vote = false;
    filter.failed = false;
    filter.account_include = programs;
    filter.account_required = {wallet};
    filters.push_back(std::move(filter));
  }
  return filters;
}

TransactionMonitor::TransactionMonitor(Config config)
    : config_(std::move(config)),
      wallet_set_(config_.wallets.begin(), config_.wallets.end()) {}

TransactionMonitor::~TransactionMonitor() { stop(); }

void TransactionMonitor::on_swap(SwapHandler handler) {
  on_swap_ = std::move(handler);
}

void TransactionMonitor::on_error(ErrorHandler handler) {
  std::lock_guard<std::mutex> lock(shared_->mutex);
  shared_->on_error = std::move(handler);
}

void TransactionMonitor::start() {
  auto& logger = Logger::instance();

  if (supervisor_ && supervisor_->active()) {
    logger.warn(kModule, "Monitor is already running");
    return;
  }
  supervisor_.reset();  // a supervisor that gave up cannot be restarted

  try {
    if (!config_.enable_pump && !config_.enable_raydium) {
      throw std::runtime_error(
          "At least one program must be enabled for monitoring");
    }

    const auto followed = wallets();
    if (followed.empty()) {
      throw std::runtime_error("Add at least one wallet to monitor");
    }

    // The executor loads the wallet now, so no copy pays for it later, and
    // tells us which wallet is ours so its own trades are not copied back.
    auto& executor = CopyExecutor::instance();
    executor.start();
    {
      std::lock_guard<std::mutex> lock(wallets_mutex_);
      own_wallet_ = executor.wallet_address();
    }

    // The endpoint can carry an API key in its path, so it is not logged.
    logger.info(kModule, "Connecting to gRPC endpoint...");

    std::string listed;
    for (const auto& wallet : followed) {
      if (!listed.empty()) listed += ", ";
      listed += cli::shorten(wallet);
    }
    logger.info(kModule, "Monitoring " + std::to_string(followed.size()) +
                             " wallet(s): " + listed);

    SubscriptionRequest request;
    request.commitment = config_.commitment;
    request.transactions = build_transaction_filters(
        followed, config_.enable_pump, config_.enable_raydium);

    std::string programs;
    for (const auto& program : request.transactions.front().account_include) {
      if (!programs.empty()) programs += ", ";
      programs += program;
    }
    logger.info(kModule, "Monitoring programs: " + programs);

    StreamHandlers handlers;
    handlers.on_transaction = [this](TransactionUpdate&& tx) {
      handle_transaction(std::move(tx));
    };

    StreamSupervisor::Options options;
    options.module = kModule;
    options.geyser.endpoint = config_.grpc_endpoint;
    options.geyser.x_token = config_.x_token;

    auto supervisor = std::make_unique<StreamSupervisor>(
        std::move(options), std::move(request), std::move(handlers),
        [this](MonitorErrorType type, const std::string& message) {
          emit_error(type, message);
        });
    supervisor->start();
    supervisor_ = std::move(supervisor);
  } catch (const std::exception& error) {
    logger.error(kModule, "Error starting monitor", error.what());
    emit_error(MonitorErrorType::Startup, error.what());
    throw;
  }

  {
    std::lock_guard<std::mutex> lock(shared_->mutex);
    shared_->status.connected_at = std::chrono::system_clock::now();
  }
  logger.success(kModule, "Monitor started successfully");
}

void TransactionMonitor::stop() {
  if (!supervisor_) return;

  // In-flight copies are left to finish on the executor's threads; they
  // report into shared_, which they keep alive.
  supervisor_->stop();
  supervisor_.reset();
  Logger::instance().info(kModule, "Monitor stopped successfully");
}

MonitorStatus TransactionMonitor::status() const {
  MonitorStatus status;
  {
    std::lock_guard<std::mutex> lock(shared_->mutex);
    status = shared_->status;
  }
  status.is_active = supervisor_ != nullptr && supervisor_->active();
  return status;
}

std::vector<std::string> TransactionMonitor::wallets() const {
  std::lock_guard<std::mutex> lock(wallets_mutex_);
  return {wallet_set_.begin(), wallet_set_.end()};
}

void TransactionMonitor::add_wallet(const std::string& address) {
  if (!Pubkey::try_parse(address).has_value()) {
    throw std::invalid_argument("Invalid wallet address: " + address);
  }
  {
    std::lock_guard<std::mutex> lock(wallets_mutex_);
    if (!wallet_set_.insert(address).second) return;
  }
  Logger::instance().info(kModule, "Restarting monitor to include new wallet");
  restart_if_active();
}

void TransactionMonitor::remove_wallet(const std::string& address) {
  {
    std::lock_guard<std::mutex> lock(wallets_mutex_);
    if (wallet_set_.erase(address) == 0) return;
  }
  Logger::instance().info(kModule, "Restarting monitor after wallet removal");
  restart_if_active();
}

void TransactionMonitor::restart_if_active() {
  if (!supervisor_ || !supervisor_->active()) return;
  stop();
  start();
}

bool TransactionMonitor::first_sighting(const std::string& signature) {
  // The most recent 1000 signatures. The TypeScript build kept a Set and
  // trimmed it to the same size on an hourly timer; trimming as entries
  // arrive gives the same bound without the timer.
  std::lock_guard<std::mutex> lock(processed_mutex_);
  if (!processed_.insert(signature).second) return false;

  processed_order_.push_back(signature);
  if (processed_order_.size() > kMaxProcessedTransactions) {
    processed_.erase(processed_order_.front());
    processed_order_.pop_front();
  }
  return true;
}

void TransactionMonitor::emit_error(MonitorErrorType type,
                                    const std::string& message,
                                    const std::string& transaction) {
  ErrorHandler handler;
  {
    std::lock_guard<std::mutex> lock(shared_->mutex);
    handler = shared_->on_error;
  }
  if (handler) {
    handler(MonitorError{type, message, transaction,
                         std::chrono::system_clock::now()});
  }
}

void TransactionMonitor::handle_transaction(TransactionUpdate&& tx) {
  {
    std::lock_guard<std::mutex> lock(shared_->mutex);
    ++shared_->status.processed_transactions;
  }

  if (tx.signature.empty()) return;

  // Recorded before anything else, so a transaction delivered twice (a
  // reconnect can replay one) is only ever copied once.
  if (!first_sighting(tx.signature)) return;

  // The server filters already guarantee a followed wallet is involved; this
  // checks it is the one that signed and paid, and that it is not ours.
  const auto wallet = extract_wallet_address(tx);
  if (!wallet.has_value()) return;
  {
    std::lock_guard<std::mutex> lock(wallets_mutex_);
    if (wallet_set_.count(*wallet) == 0) return;
    if (*wallet == own_wallet_) return;
  }

  std::optional<ParsedSwap> swap;
  try {
    swap = parse_swap(tx, *wallet);
  } catch (const std::exception& error) {
    Logger::instance().error(kModule, "Error processing transaction",
                             error.what());
    emit_error(MonitorErrorType::Parse, error.what(), tx.signature);
    return;
  }
  if (!swap.has_value()) return;

  {
    std::lock_guard<std::mutex> lock(shared_->mutex);
    shared_->status.last_transaction_at = std::chrono::system_clock::now();
    ++shared_->status.detected_swaps;
  }
  if (on_swap_) on_swap_(*swap);

  // Failed transactions are filtered out by the server; the check stays as
  // the TypeScript build had it.
  if (!base_of(*swap).success) return;

  auto shared = shared_;
  CopyExecutor::instance().submit(
      std::move(*swap), tx.received_at,
      [shared](const CopyExecutor::Outcome& outcome) {
        ErrorHandler handler;
        {
          std::lock_guard<std::mutex> lock(shared->mutex);
          if (outcome.success) {
            ++shared->status.successful_copies;
          } else {
            ++shared->status.failed_copies;
          }
          handler = shared->on_error;
        }
        if (!outcome.success && handler) {
          handler(MonitorError{MonitorErrorType::Execution, outcome.error,
                               outcome.original_signature,
                               std::chrono::system_clock::now()});
        }
      });
}

}  // namespace eclipse::copytrade
