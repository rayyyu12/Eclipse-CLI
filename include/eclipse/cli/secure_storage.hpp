#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace eclipse::cli {

/// Fields held in the encrypted credential blob.
struct SecureCredentials {
  std::optional<std::string> rpc_url;
  std::optional<std::string> private_key;  ///< base58, 64-byte secret
  std::optional<std::string> grpc_url;
  std::optional<std::string> auth_token;
  std::optional<std::string> ws_endpoint;
  std::optional<std::string> tracked_wallets;  ///< JSON array

  bool empty() const;
};

/// AES-256-GCM credential store at ~/.eclipse-cli/credentials.enc.
///
/// The key is derived from a machine-local secret with PBKDF2 and the file is
/// written 0600. This keeps the private key off disk in plaintext; it is not
/// protection against someone who already has the user's account.
class SecureStorage {
 public:
  static SecureStorage& instance();

  SecureCredentials get() const;

  /// Throws std::runtime_error when the store is not writable. Callers report
  /// that to the user rather than letting it end the session.
  void save(const SecureCredentials& credentials);

  void set(const std::string& field, const std::optional<std::string>& value);
  void clear();

  /// False when the config directory could not be created or written. The CLI
  /// still runs; nothing persists between sessions.
  bool available() const { return available_; }

  const std::string& path() const { return credentials_path_; }

 private:
  SecureStorage();

  void ensure_key();
  std::vector<std::uint8_t> encrypt(const std::string& plaintext,
                                    std::vector<std::uint8_t>& iv_out,
                                    std::vector<std::uint8_t>& tag_out) const;
  std::optional<std::string> decrypt(const std::vector<std::uint8_t>& cipher,
                                     const std::vector<std::uint8_t>& iv,
                                     const std::vector<std::uint8_t>& tag) const;

  mutable std::mutex mutex_;
  std::string config_dir_;
  std::string credentials_path_;
  std::string key_path_;
  std::vector<std::uint8_t> key_;
  bool available_ = true;
};

}  // namespace eclipse::cli
