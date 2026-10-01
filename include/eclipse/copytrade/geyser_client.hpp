#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "eclipse/common/pubkey.hpp"
#include "eclipse/copytrade/types.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::copytrade {

// A Yellowstone gRPC (Dragon's Mouth) Subscribe stream.
//
// This header has no gRPC in it. The implementation is geyser_client.cpp when
// the build is configured with -DECLIPSE_COPYTRADE=ON, and
// geyser_client_unavailable.cpp otherwise, so everything above the stream
// (decoding, the monitors, the CLI) compiles either way.

struct GeyserOptions {
  /// http(s)://host[:port]. https means TLS; the port defaults to 443 for
  /// https and 80 for http, as in the TypeScript client.
  std::string endpoint;

  /// Sent as the "x-token" header on the stream when non-empty. Never logged.
  std::string x_token;

  /// How long to wait for the channel to connect before giving up.
  std::chrono::seconds connect_timeout{10};
};

/// One named entry of SubscribeRequest.transactions. Within an entry every
/// condition must hold; across entries the server ORs them and sends each
/// matching transaction once, naming the entries it matched.
struct TransactionFilter {
  std::string name;
  bool vote = false;
  bool failed = false;
  std::vector<std::string> account_include;   ///< mentions any of these
  std::vector<std::string> account_required;  ///< mentions all of these
};

/// One named entry of SubscribeRequest.accounts.
struct AccountFilter {
  std::string name;
  std::vector<std::string> accounts;  ///< any of these
};

struct SubscriptionRequest {
  std::vector<TransactionFilter> transactions;
  std::vector<AccountFilter> accounts;
  net::Commitment commitment = net::Commitment::Processed;
};

struct AccountUpdate {
  Pubkey pubkey;
  std::uint64_t lamports = 0;
  std::uint64_t slot = 0;
};

/// Called on the thread running subscribe(), in stream order.
struct StreamHandlers {
  /// The request has been written; the subscription is live.
  std::function<void()> on_subscribed;
  std::function<void(TransactionUpdate&&)> on_transaction;
  std::function<void(const AccountUpdate&)> on_account;
  /// Every update, server pings included. Feeds the stale-stream check.
  std::function<void()> on_message;
};

class GeyserClient {
 public:
  /// False when the binary was built without -DECLIPSE_COPYTRADE=ON. The
  /// menu checks this before offering copy trading.
  static bool available();

  explicit GeyserClient(GeyserOptions options);
  ~GeyserClient();

  GeyserClient(const GeyserClient&) = delete;
  GeyserClient& operator=(const GeyserClient&) = delete;

  /// Opens one Subscribe stream, writes the request and dispatches updates on
  /// the calling thread until the stream ends. Returns why it ended; empty
  /// when it was ended by cancel_current() or shutdown().
  std::string subscribe(const SubscriptionRequest& request,
                        const StreamHandlers& handlers);

  /// Ends the stream in progress, if any; a later subscribe() still works.
  /// Used to force a reconnect.
  void cancel_current();

  /// Ends the stream in progress and makes every later subscribe() return at
  /// once. Thread-safe.
  void shutdown();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace eclipse::copytrade
