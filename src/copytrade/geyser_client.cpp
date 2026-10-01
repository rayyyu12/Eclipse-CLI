// The Yellowstone gRPC stream. Built only with -DECLIPSE_COPYTRADE=ON, against
// code protoc generates from third_party/yellowstone-grpc-proto.
//
// This is the one place protobuf types appear. Each update is converted to the
// plain structs in types.hpp as it is read, and everything downstream works on
// those.

#include "eclipse/copytrade/geyser_client.hpp"

#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <mutex>
#include <optional>

#include "eclipse/common/base58.hpp"
#include "eclipse/common/logger.hpp"
#include "geyser.grpc.pb.h"
#include "geyser.pb.h"

namespace eclipse::copytrade {
namespace {

// Fully qualified: inside eclipse::, a bare "solana" names eclipse::solana.
namespace storage = ::solana::storage::ConfirmedBlock;

using SubscribeStream =
    ::grpc::ClientReaderWriter<::geyser::SubscribeRequest,
                               ::geyser::SubscribeUpdate>;

/// 64 MiB, as the TypeScript client set it. A block-sized transaction update
/// with full meta can exceed gRPC's 4 MiB default.
constexpr int kMaxReceiveMessageBytes = 64 * 1024 * 1024;

struct Target {
  std::string authority;  ///< host:port
  bool tls = true;
};

/// "https://host[:port][/path]" to "host:port". The port defaults by scheme,
/// and any path is dropped: gRPC addresses a host, not a URL.
std::optional<Target> parse_endpoint(const std::string& endpoint) {
  Target target;
  std::string rest;
  if (endpoint.rfind("https://", 0) == 0) {
    target.tls = true;
    rest = endpoint.substr(8);
  } else if (endpoint.rfind("http://", 0) == 0) {
    target.tls = false;
    rest = endpoint.substr(7);
  } else {
    return std::nullopt;
  }

  rest = rest.substr(0, rest.find('/'));
  if (rest.empty()) return std::nullopt;

  const auto bracket = rest.rfind(']');  // IPv6 literal
  const auto colon = rest.rfind(':');
  const bool has_port =
      colon != std::string::npos &&
      (bracket == std::string::npos || colon > bracket);
  if (!has_port) rest += target.tls ? ":443" : ":80";

  target.authority = rest;
  return target;
}

std::shared_ptr<::grpc::Channel> make_channel(const Target& target) {
  ::grpc::ChannelArguments args;

  // The channel options the TypeScript client passed, by their gRPC core
  // names: keepalive pings every two minutes, even with no call in flight,
  // so an idle stream is not dropped by something in between.
  args.SetInt("grpc.keepalive_time_ms", 120000);
  args.SetInt("grpc.http2.min_time_between_pings_ms", 120000);
  args.SetInt("grpc.keepalive_timeout_ms", 20000);
  args.SetInt("grpc.http2.max_pings_without_data", 0);
  args.SetInt("grpc.keepalive_permit_without_calls", 1);
  args.SetMaxReceiveMessageSize(kMaxReceiveMessageBytes);

  const auto credentials =
      target.tls ? ::grpc::SslCredentials(::grpc::SslCredentialsOptions())
                 : ::grpc::InsecureChannelCredentials();
  return ::grpc::CreateCustomChannel(target.authority, credentials, args);
}

::geyser::CommitmentLevel to_proto(net::Commitment commitment) {
  switch (commitment) {
    case net::Commitment::Processed: return ::geyser::PROCESSED;
    case net::Commitment::Confirmed: return ::geyser::CONFIRMED;
    case net::Commitment::Finalized: return ::geyser::FINALIZED;
  }
  return ::geyser::PROCESSED;
}

::geyser::SubscribeRequest build_request(const SubscriptionRequest& request) {
  ::geyser::SubscribeRequest out;

  auto& transactions = *out.mutable_transactions();
  for (const auto& filter : request.transactions) {
    ::geyser::SubscribeRequestFilterTransactions& entry =
        transactions[filter.name];
    entry.set_vote(filter.vote);
    entry.set_failed(filter.failed);
    for (const auto& account : filter.account_include) {
      entry.add_account_include(account);
    }
    for (const auto& account : filter.account_required) {
      entry.add_account_required(account);
    }
  }

  auto& accounts = *out.mutable_accounts();
  for (const auto& filter : request.accounts) {
    ::geyser::SubscribeRequestFilterAccounts& entry = accounts[filter.name];
    for (const auto& account : filter.accounts) entry.add_account(account);
  }

  out.set_commitment(to_proto(request.commitment));
  return out;
}

/// A 32-byte key from a bytes field. A malformed one becomes the default key
/// rather than being skipped, so the indices after it still line up.
Pubkey to_pubkey(const std::string& bytes) {
  Pubkey::Bytes key{};
  if (bytes.size() == Pubkey::kSize) {
    std::transform(bytes.begin(), bytes.end(), key.begin(),
                   [](char c) { return static_cast<std::uint8_t>(c); });
  }
  return Pubkey(key);
}

std::vector<std::uint8_t> to_bytes(const std::string& bytes) {
  return std::vector<std::uint8_t>(bytes.begin(), bytes.end());
}

template <typename ProtoInstruction>
CompiledInstruction to_instruction(const ProtoInstruction& ix) {
  CompiledInstruction out;
  out.program_id_index = ix.program_id_index();
  out.accounts = to_bytes(ix.accounts());
  out.data = to_bytes(ix.data());
  return out;
}

TokenBalance to_token_balance(const storage::TokenBalance& balance) {
  TokenBalance out;
  out.account_index = balance.account_index();
  out.mint = balance.mint();
  out.owner = balance.owner();
  out.ui_token_amount.ui_amount = balance.ui_token_amount().ui_amount();
  out.ui_token_amount.decimals = balance.ui_token_amount().decimals();
  out.ui_token_amount.amount = balance.ui_token_amount().amount();
  return out;
}

TransactionUpdate to_transaction(
    const ::geyser::SubscribeUpdateTransaction& update,
    std::chrono::steady_clock::time_point received_at) {
  const auto& info = update.transaction();
  const auto& message = info.transaction().message();
  const auto& meta = info.meta();

  TransactionUpdate tx;
  tx.slot = update.slot();
  tx.received_at = received_at;
  tx.signature = base58::encode(
      reinterpret_cast<const std::uint8_t*>(info.signature().data()),
      info.signature().size());

  // Static keys, then the lookup-table addresses, which is the order account
  // indices count in. The TypeScript build read only the static keys.
  const auto append_keys = [&tx](const auto& keys) {
    for (const auto& key : keys) tx.account_keys.push_back(to_pubkey(key));
  };
  tx.account_keys.reserve(static_cast<std::size_t>(
      message.account_keys_size() + meta.loaded_writable_addresses_size() +
      meta.loaded_readonly_addresses_size()));
  append_keys(message.account_keys());
  append_keys(meta.loaded_writable_addresses());
  append_keys(meta.loaded_readonly_addresses());

  for (const auto& ix : message.instructions()) {
    tx.instructions.push_back(to_instruction(ix));
  }
  for (const auto& inner : meta.inner_instructions()) {
    InnerInstructions group;
    group.index = inner.index();
    for (const auto& ix : inner.instructions()) {
      group.instructions.push_back(to_instruction(ix));
    }
    tx.inner_instructions.push_back(std::move(group));
  }

  tx.log_messages.assign(meta.log_messages().begin(),
                         meta.log_messages().end());
  tx.pre_balances.assign(meta.pre_balances().begin(),
                         meta.pre_balances().end());
  tx.post_balances.assign(meta.post_balances().begin(),
                          meta.post_balances().end());
  for (const auto& balance : meta.pre_token_balances()) {
    tx.pre_token_balances.push_back(to_token_balance(balance));
  }
  for (const auto& balance : meta.post_token_balances()) {
    tx.post_token_balances.push_back(to_token_balance(balance));
  }

  tx.failed = meta.has_err();
  return tx;
}

AccountUpdate to_account(const ::geyser::SubscribeUpdateAccount& update) {
  AccountUpdate out;
  out.slot = update.slot();
  out.lamports = update.account().lamports();
  out.pubkey = to_pubkey(update.account().pubkey());
  return out;
}

std::string describe(const char* what, const ::grpc::Status& status) {
  const char* code = "error";
  switch (status.error_code()) {
    case ::grpc::StatusCode::OK:                 code = "OK"; break;
    case ::grpc::StatusCode::CANCELLED:          code = "CANCELLED"; break;
    case ::grpc::StatusCode::INVALID_ARGUMENT:   code = "INVALID_ARGUMENT"; break;
    case ::grpc::StatusCode::DEADLINE_EXCEEDED:  code = "DEADLINE_EXCEEDED"; break;
    case ::grpc::StatusCode::PERMISSION_DENIED:  code = "PERMISSION_DENIED"; break;
    case ::grpc::StatusCode::RESOURCE_EXHAUSTED: code = "RESOURCE_EXHAUSTED"; break;
    case ::grpc::StatusCode::UNAVAILABLE:        code = "UNAVAILABLE"; break;
    case ::grpc::StatusCode::UNAUTHENTICATED:    code = "UNAUTHENTICATED"; break;
    default: break;
  }
  std::string out = std::string(what) + ": " + code;
  if (!status.error_message().empty()) out += " (" + status.error_message() + ")";
  return out;
}

}  // namespace

struct GeyserClient::Impl {
  GeyserOptions options;
  std::optional<Target> target;

  // Kept across reconnects: re-subscribing reuses the HTTP/2 connection
  // when it is still up, instead of paying for a new TLS handshake.
  std::shared_ptr<::grpc::Channel> channel;
  std::unique_ptr<::geyser::Geyser::Stub> stub;

  std::mutex mutex;
  ::grpc::ClientContext* active = nullptr;  ///< the stream in progress
  bool cancel_requested = false;
  bool shut_down = false;
};

bool GeyserClient::available() { return true; }

GeyserClient::GeyserClient(GeyserOptions options)
    : impl_(std::make_unique<Impl>()) {
  impl_->target = parse_endpoint(options.endpoint);
  impl_->options = std::move(options);
}

GeyserClient::~GeyserClient() { shutdown(); }

void GeyserClient::cancel_current() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->active == nullptr) return;
  impl_->cancel_requested = true;
  impl_->active->TryCancel();
}

void GeyserClient::shutdown() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->shut_down = true;
  if (impl_->active != nullptr) {
    impl_->cancel_requested = true;
    impl_->active->TryCancel();
  }
}

std::string GeyserClient::subscribe(const SubscriptionRequest& request,
                                    const StreamHandlers& handlers) {
  Impl& impl = *impl_;
  {
    std::lock_guard<std::mutex> lock(impl.mutex);
    if (impl.shut_down) return {};
  }
  if (!impl.target.has_value()) {
    return "GRPC URL must start with http:// or https://";
  }

  if (!impl.channel) {
    impl.channel = make_channel(*impl.target);
    impl.stub = ::geyser::Geyser::NewStub(impl.channel);
  }

  // Fail fast with a clear reason rather than a stream error later.
  const auto deadline =
      std::chrono::system_clock::now() + impl.options.connect_timeout;
  if (!impl.channel->WaitForConnected(deadline)) {
    return "could not connect to the gRPC endpoint";
  }

  ::grpc::ClientContext context;
  if (!impl.options.x_token.empty()) {
    context.AddMetadata("x-token", impl.options.x_token);
  }

  {
    std::lock_guard<std::mutex> lock(impl.mutex);
    if (impl.shut_down) return {};
    impl.active = &context;
    impl.cancel_requested = false;
  }

  // Whatever happens below, cancel_current() must stop pointing at this
  // context before it goes out of scope.
  struct ActiveReset {
    Impl& impl;
    ~ActiveReset() {
      std::lock_guard<std::mutex> lock(impl.mutex);
      impl.active = nullptr;
    }
  } reset{impl};

  std::unique_ptr<SubscribeStream> stream = impl.stub->Subscribe(&context);

  // One request carries every filter. The write side stays open for the life
  // of the stream; Yellowstone treats a later request as a new filter set.
  if (!stream->Write(build_request(request))) {
    return describe("could not write the subscription", stream->Finish());
  }
  if (handlers.on_subscribed) handlers.on_subscribed();

  ::geyser::SubscribeUpdate update;
  while (stream->Read(&update)) {
    const auto received_at = std::chrono::steady_clock::now();
    if (handlers.on_message) handlers.on_message();

    switch (update.update_oneof_case()) {
      case ::geyser::SubscribeUpdate::kTransaction:
        if (handlers.on_transaction) {
          handlers.on_transaction(
              to_transaction(update.transaction(), received_at));
        }
        break;
      case ::geyser::SubscribeUpdate::kAccount:
        if (handlers.on_account) handlers.on_account(to_account(update.account()));
        break;
      default:
        // Server pings and anything this request did not ask for. Pings
        // still count as traffic for the stale-stream check above.
        break;
    }
  }

  const ::grpc::Status status = stream->Finish();
  {
    std::lock_guard<std::mutex> lock(impl.mutex);
    if (impl.cancel_requested) return {};
  }
  return describe("stream ended", status);
}

}  // namespace eclipse::copytrade
