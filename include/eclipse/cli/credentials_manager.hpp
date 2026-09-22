#pragma once

#include <memory>
#include <optional>
#include <string>

#include "eclipse/common/keypair.hpp"
#include "eclipse/net/rpc_client.hpp"

namespace eclipse::cli {

/// Validates and stores the RPC endpoint, private key and optional streaming
/// endpoints. Every getter throws std::runtime_error when the value has not
/// been configured, which is what drives the "configure settings first"
/// prompts in the menu.
class CredentialsManager {
 public:
  static CredentialsManager& instance();

  // Validation. Each returns false rather than throwing so the settings
  // screens can re-prompt.
  bool validate_rpc_url(const std::string& url) const;
  bool validate_grpc_url(const std::string& url) const;
  bool validate_ws_endpoint(const std::string& url) const;
  bool validate_auth_token(const std::string& token) const;

  /// Confirms the base58 decodes to a usable 64-byte ed25519 secret.
  bool validate_private_key(const std::string& base58_key) const;

  std::string get_rpc_url() const;
  void set_rpc_url(const std::string& url);

  std::string get_grpc_url() const;
  void set_grpc_url(const std::string& url);

  std::string get_ws_endpoint() const;
  void set_ws_endpoint(const std::string& url);

  std::string get_auth_token() const;
  void set_auth_token(const std::string& token);

  std::string get_private_key() const;
  void set_private_key(const std::string& base58_key);

  bool has_credentials() const;
  void clear();

  /// A client bound to the configured endpoint. Callers that want load
  /// spreading should use ConnectionPool instead.
  std::unique_ptr<net::RpcClient> make_client() const;

  Keypair get_keypair() const;

 private:
  CredentialsManager() = default;
};

}  // namespace eclipse::cli
