#pragma once

#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <unordered_set>
#include <vector>

#include "eclipse/copytrade/geyser_client.hpp"
#include "eclipse/copytrade/stream_supervisor.hpp"
#include "eclipse/copytrade/types.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::copytrade {

/// The server-side transaction filters for the followed wallets: one named
/// filter per wallet, each requiring that wallet and including any of the
/// enabled programs, with votes and failed transactions excluded.
///
/// One filter per wallet because of how Yellowstone combines conditions.
/// account_required means the transaction must mention every account listed,
/// so a single filter requiring all the wallets matches only transactions
/// that involve all of them at once: with two or more wallets, effectively
/// nothing. The TypeScript build did exactly that. Separate filters are ORed
/// by the server, which gives "(pump.fun or Raydium) and wallet N" for each N.
std::vector<TransactionFilter> build_transaction_filters(
    const std::vector<std::string>& wallets, bool enable_pump,
    bool enable_raydium);

/// Follows wallets over a Yellowstone stream and copies their pump.fun and
/// Raydium trades: transactionMonitor.ts.
///
/// The stream is at "processed" commitment, the earliest a transaction is
/// visible. Each update is decoded on the stream thread, which only touches
/// local data, then handed to CopyExecutor, so the next update is read while
/// the copy is in flight.
class TransactionMonitor {
 public:
  struct Config {
    std::string grpc_endpoint;
    std::string x_token;
    net::Commitment commitment = net::Commitment::Processed;
    std::vector<std::string> wallets;
    bool enable_pump = true;
    bool enable_raydium = true;
  };

  using SwapHandler = std::function<void(const ParsedSwap&)>;
  using ErrorHandler = std::function<void(const MonitorError&)>;

  explicit TransactionMonitor(Config config);
  ~TransactionMonitor();

  TransactionMonitor(const TransactionMonitor&) = delete;
  TransactionMonitor& operator=(const TransactionMonitor&) = delete;

  /// Set before start(). Called on the stream thread or a copy worker.
  void on_swap(SwapHandler handler);
  void on_error(ErrorHandler handler);

  /// Starts the copy executor and subscribes. Returns once the subscription
  /// is live; throws std::runtime_error when it cannot be.
  void start();
  void stop();

  MonitorStatus status() const;
  std::vector<std::string> wallets() const;

  /// The server filters name the wallets, so a running monitor resubscribes
  /// with the new set. add_wallet throws std::invalid_argument on a malformed
  /// address.
  void add_wallet(const std::string& address);
  void remove_wallet(const std::string& address);

 private:
  /// Counters shared with copies still in flight, which can outlive a stop.
  struct Shared {
    mutable std::mutex mutex;
    MonitorStatus status;
    ErrorHandler on_error;
  };

  void handle_transaction(TransactionUpdate&& tx);
  bool first_sighting(const std::string& signature);
  void emit_error(MonitorErrorType type, const std::string& message,
                  const std::string& transaction = {});
  void restart_if_active();

  static constexpr std::size_t kMaxProcessedTransactions = 1000;

  Config config_;
  std::shared_ptr<Shared> shared_ = std::make_shared<Shared>();
  SwapHandler on_swap_;

  mutable std::mutex wallets_mutex_;
  std::set<std::string> wallet_set_;
  std::string own_wallet_;

  std::mutex processed_mutex_;
  std::unordered_set<std::string> processed_;
  std::deque<std::string> processed_order_;

  std::unique_ptr<StreamSupervisor> supervisor_;
};

}  // namespace eclipse::copytrade
