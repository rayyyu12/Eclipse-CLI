#include "eclipse/copytrade/balance_monitor.hpp"

#include "eclipse/common/logger.hpp"
#include "eclipse/solana/programs.hpp"

namespace eclipse::copytrade {
namespace {

constexpr const char* kModule = "BalanceMonitor";

double lamports_to_sol(std::uint64_t lamports) {
  return static_cast<double>(lamports) /
         static_cast<double>(solana::kLamportsPerSol);
}

}  // namespace

BalanceMonitor::BalanceMonitor(Config config) : config_(std::move(config)) {}

BalanceMonitor::~BalanceMonitor() { stop(); }

void BalanceMonitor::start(net::RpcClient& client) {
  if (active()) {
    Logger::instance().warn(kModule, "Balance monitor is already running");
    return;
  }
  supervisor_.reset();

  // Seed from RPC so the screen has a figure before the first account update,
  // which only arrives when a balance changes.
  {
    std::lock_guard<std::mutex> lock(mutex_);
    balances_.clear();
    for (const auto& wallet : config_.wallets) {
      WalletBalance balance;
      if (const auto key = Pubkey::try_parse(wallet)) {
        if (const auto lamports = client.get_balance(*key)) {
          balance.sol = lamports_to_sol(*lamports);
        }
      }
      balances_.emplace(wallet, balance);
    }
  }

  SubscriptionRequest request;
  request.commitment = config_.commitment;
  request.accounts.push_back(AccountFilter{"walletBalance", config_.wallets});

  StreamHandlers handlers;
  handlers.on_account = [this](const AccountUpdate& update) {
    handle_account(update);
  };

  StreamSupervisor::Options options;
  options.module = kModule;
  options.geyser.endpoint = config_.grpc_endpoint;
  options.geyser.x_token = config_.x_token;

  auto supervisor = std::make_unique<StreamSupervisor>(
      std::move(options), std::move(request), std::move(handlers),
      [](MonitorErrorType type, const std::string& message) {
        Logger::instance().warn(kModule, to_string(type), message);
      });
  supervisor->start();
  supervisor_ = std::move(supervisor);
}

void BalanceMonitor::stop() {
  if (!supervisor_) return;
  supervisor_->stop();
  supervisor_.reset();
  Logger::instance().info(kModule, "Balance monitor stopped");
}

bool BalanceMonitor::active() const {
  return supervisor_ != nullptr && supervisor_->active();
}

std::map<std::string, BalanceMonitor::WalletBalance> BalanceMonitor::balances()
    const {
  std::lock_guard<std::mutex> lock(mutex_);
  return balances_;
}

void BalanceMonitor::handle_account(const AccountUpdate& update) {
  // A zero-lamport update is skipped, as it was in the TypeScript build.
  if (update.lamports == 0) return;

  const double sol = lamports_to_sol(update.lamports);
  std::lock_guard<std::mutex> lock(mutex_);

  auto& balance = balances_[update.pubkey.to_base58()];
  if (balance.sol == sol) return;

  balance.sol = sol;
  balance.updated_at = std::chrono::system_clock::now();
  balance.slot = update.slot;
}

}  // namespace eclipse::copytrade
