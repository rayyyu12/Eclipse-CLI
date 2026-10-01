#pragma once

#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "eclipse/copytrade/stream_supervisor.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::copytrade {

/// Streams the SOL balance of the followed wallets for the copy trade
/// screen: balanceUpdater.ts.
///
/// The TypeScript BalanceMonitor was a singleton for one wallet, and the
/// handler's "for each wallet" loop therefore only ever watched the first.
/// Here one accounts subscription covers them all (account filters match any
/// listed address), so every followed wallet shows a live balance.
class BalanceMonitor {
 public:
  struct Config {
    std::string grpc_endpoint;
    std::string x_token;
    net::Commitment commitment = net::Commitment::Processed;
    std::vector<std::string> wallets;
  };

  struct WalletBalance {
    double sol = 0.0;
    std::optional<std::chrono::system_clock::time_point> updated_at;
    std::uint64_t slot = 0;
  };

  explicit BalanceMonitor(Config config);
  ~BalanceMonitor();

  BalanceMonitor(const BalanceMonitor&) = delete;
  BalanceMonitor& operator=(const BalanceMonitor&) = delete;

  /// Seeds each balance over RPC, then subscribes. Throws
  /// std::runtime_error when the subscription cannot be established.
  void start(net::RpcClient& client);
  void stop();

  bool active() const;
  std::map<std::string, WalletBalance> balances() const;

 private:
  void handle_account(const AccountUpdate& update);

  Config config_;
  mutable std::mutex mutex_;
  std::map<std::string, WalletBalance> balances_;
  std::unique_ptr<StreamSupervisor> supervisor_;
};

}  // namespace eclipse::copytrade
