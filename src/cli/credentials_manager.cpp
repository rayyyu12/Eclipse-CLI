#include "eclipse/cli/credentials_manager.hpp"

#include <stdexcept>

#include "eclipse/cli/secure_storage.hpp"
#include "eclipse/cli/validation.hpp"
#include "eclipse/common/base58.hpp"
#include "eclipse/common/logger.hpp"

namespace eclipse::cli {
namespace {

std::string require(const std::optional<std::string>& value,
                    const char* what) {
  if (!value.has_value() || value->empty()) {
    throw std::runtime_error(std::string(what) + " is not configured");
  }
  return *value;
}

}  // namespace

CredentialsManager& CredentialsManager::instance() {
  static CredentialsManager manager;
  return manager;
}

bool CredentialsManager::validate_rpc_url(const std::string& url) const {
  if (!validate_http_url(url)) return false;

  // A URL that parses but does not answer is worse than one that does not
  // parse, so this actually calls the endpoint.
  net::RpcClient probe(url);
  if (probe.get_latest_blockhash().has_value()) return true;

  Logger::instance().warn("Credentials", "RPC URL did not respond",
                          probe.last_error());
  return false;
}

bool CredentialsManager::validate_grpc_url(const std::string& url) const {
  return validate_http_url(url);
}

bool CredentialsManager::validate_ws_endpoint(const std::string& url) const {
  return validate_ws_url(url);
}

bool CredentialsManager::validate_auth_token(const std::string& token) const {
  return !token.empty();
}

bool CredentialsManager::validate_private_key(
    const std::string& base58_key) const {
  try {
    // Round-tripping through Keypair is the real test: it confirms the bytes
    // decode, are the right length, and form a consistent ed25519 pair.
    Keypair::from_base58_secret(base58_key);
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

std::string CredentialsManager::get_rpc_url() const {
  return require(SecureStorage::instance().get().rpc_url, "RPC URL");
}

void CredentialsManager::set_rpc_url(const std::string& url) {
  if (!validate_rpc_url(url)) {
    throw std::runtime_error("RPC URL is not reachable");
  }
  SecureStorage::instance().set("rpcUrl", url);
}

std::string CredentialsManager::get_grpc_url() const {
  return require(SecureStorage::instance().get().grpc_url, "GRPC URL");
}

void CredentialsManager::set_grpc_url(const std::string& url) {
  if (!validate_grpc_url(url)) {
    throw std::runtime_error("GRPC URL is malformed");
  }
  SecureStorage::instance().set("grpcUrl", url);
}

std::string CredentialsManager::get_ws_endpoint() const {
  return require(SecureStorage::instance().get().ws_endpoint,
                 "WebSocket endpoint");
}

void CredentialsManager::set_ws_endpoint(const std::string& url) {
  if (!validate_ws_endpoint(url)) {
    throw std::runtime_error("WebSocket URL must start with ws:// or wss://");
  }
  SecureStorage::instance().set("wsEndpoint", url);
}

std::string CredentialsManager::get_auth_token() const {
  return require(SecureStorage::instance().get().auth_token, "Auth token");
}

void CredentialsManager::set_auth_token(const std::string& token) {
  if (!validate_auth_token(token)) {
    throw std::runtime_error("auth token cannot be empty");
  }
  SecureStorage::instance().set("authToken", token);
}

std::string CredentialsManager::get_private_key() const {
  return require(SecureStorage::instance().get().private_key, "Private key");
}

void CredentialsManager::set_private_key(const std::string& base58_key) {
  if (!validate_private_key(base58_key)) {
    throw std::runtime_error("private key is not a valid base58 ed25519 key");
  }
  // Stored as base58 rather than the JSON byte array the TypeScript build
  // used: it is what wallets export, and it is shorter on disk.
  SecureStorage::instance().set("privateKey", base58_key);
}

bool CredentialsManager::has_credentials() const {
  const auto credentials = SecureStorage::instance().get();
  return credentials.rpc_url.has_value() &&
         !credentials.rpc_url->empty() &&
         credentials.private_key.has_value() &&
         !credentials.private_key->empty();
}

void CredentialsManager::clear() { SecureStorage::instance().clear(); }

std::unique_ptr<net::RpcClient> CredentialsManager::make_client() const {
  return std::make_unique<net::RpcClient>(get_rpc_url(),
                                          net::Commitment::Confirmed);
}

Keypair CredentialsManager::get_keypair() const {
  const std::string stored = get_private_key();

  // Older installs wrote the key as a JSON byte array. Accept both so an
  // upgrade does not lose the wallet.
  if (!stored.empty() && stored.front() == '[') {
    return Keypair::from_json_array(stored);
  }
  return Keypair::from_base58_secret(stored);
}

}  // namespace eclipse::cli
