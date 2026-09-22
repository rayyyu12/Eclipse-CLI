#include "eclipse/cli/secure_storage.hpp"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>

#include "eclipse/common/logger.hpp"

#if !defined(_WIN32)
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace eclipse::cli {
namespace {

using Json = nlohmann::json;

constexpr std::size_t kKeySize = 32;  // AES-256
constexpr std::size_t kIvSize = 12;   // GCM standard nonce
constexpr std::size_t kTagSize = 16;

std::string home_directory() {
  if (const char* home = std::getenv("HOME")) return home;
#if defined(_WIN32)
  if (const char* profile = std::getenv("USERPROFILE")) return profile;
#endif
  return ".";
}

std::string to_hex(const std::vector<std::uint8_t>& bytes) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (std::uint8_t byte : bytes) {
    out.push_back(kDigits[byte >> 4]);
    out.push_back(kDigits[byte & 0x0F]);
  }
  return out;
}

std::vector<std::uint8_t> from_hex(const std::string& text) {
  const auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };

  std::vector<std::uint8_t> out;
  out.reserve(text.size() / 2);
  for (std::size_t i = 0; i + 1 < text.size(); i += 2) {
    const int hi = nibble(text[i]);
    const int lo = nibble(text[i + 1]);
    if (hi < 0 || lo < 0) return {};
    out.push_back(static_cast<std::uint8_t>(hi * 16 + lo));
  }
  return out;
}

void restrict_permissions(const std::string& path) {
#if !defined(_WIN32)
  // Owner read/write only. The private key lives here.
  ::chmod(path.c_str(), S_IRUSR | S_IWUSR);
#endif
}

}  // namespace

bool SecureCredentials::empty() const {
  return !rpc_url.has_value() && !private_key.has_value() &&
         !grpc_url.has_value() && !auth_token.has_value() &&
         !ws_endpoint.has_value() && !tracked_wallets.has_value();
}

SecureStorage& SecureStorage::instance() {
  static SecureStorage storage;
  return storage;
}

SecureStorage::SecureStorage() {
  config_dir_ = home_directory() + "/.eclipse-cli";
  credentials_path_ = config_dir_ + "/credentials.enc";
  key_path_ = config_dir_ + "/storage.key";

  std::error_code ec;
  std::filesystem::create_directories(config_dir_, ec);
  if (ec) {
    available_ = false;
  } else {
    restrict_permissions(config_dir_);
  }

  ensure_key();
}

void SecureStorage::ensure_key() {
  // The key is generated once and kept beside the vault. This protects the
  // private key at rest against casual inspection and backups, not against an
  // attacker who already has the user's account.
  if (available_) {
    std::ifstream existing(key_path_);
    if (existing.is_open()) {
      std::string hex;
      std::getline(existing, hex);
      key_ = from_hex(hex);
      if (key_.size() == kKeySize) return;
    }
  }

  key_.resize(kKeySize);
  if (RAND_bytes(key_.data(), static_cast<int>(key_.size())) != 1) {
    throw std::runtime_error("could not generate a storage key");
  }

  if (!available_) return;

  std::ofstream out(key_path_, std::ios::trunc);
  if (!out.is_open()) {
    // A read-only or missing home directory must not stop the CLI from
    // starting: the user still needs the menu to see what is wrong. The key
    // stays in memory and nothing persists this session.
    available_ = false;
    Logger::instance().warn(
        "SecureStorage",
        "Credential store is not writable; credentials will not persist",
        key_path_);
    return;
  }
  out << to_hex(key_) << '\n';
  out.close();
  restrict_permissions(key_path_);
}

std::vector<std::uint8_t> SecureStorage::encrypt(
    const std::string& plaintext, std::vector<std::uint8_t>& iv_out,
    std::vector<std::uint8_t>& tag_out) const {
  iv_out.resize(kIvSize);
  if (RAND_bytes(iv_out.data(), static_cast<int>(iv_out.size())) != 1) {
    throw std::runtime_error("could not generate a nonce");
  }

  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (ctx == nullptr) throw std::runtime_error("could not allocate a cipher");

  std::vector<std::uint8_t> out(plaintext.size() + EVP_MAX_BLOCK_LENGTH);
  int length = 0;
  int total = 0;

  bool ok =
      EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, key_.data(),
                         iv_out.data()) == 1 &&
      EVP_EncryptUpdate(ctx, out.data(), &length,
                        reinterpret_cast<const unsigned char*>(
                            plaintext.data()),
                        static_cast<int>(plaintext.size())) == 1;
  if (ok) {
    total = length;
    ok = EVP_EncryptFinal_ex(ctx, out.data() + total, &length) == 1;
    total += length;
  }

  tag_out.resize(kTagSize);
  if (ok) {
    ok = EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG,
                             static_cast<int>(kTagSize), tag_out.data()) == 1;
  }
  EVP_CIPHER_CTX_free(ctx);

  if (!ok) throw std::runtime_error("could not encrypt the credential store");
  out.resize(static_cast<std::size_t>(total));
  return out;
}

std::optional<std::string> SecureStorage::decrypt(
    const std::vector<std::uint8_t>& cipher,
    const std::vector<std::uint8_t>& iv,
    const std::vector<std::uint8_t>& tag) const {
  if (iv.size() != kIvSize || tag.size() != kTagSize) return std::nullopt;

  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (ctx == nullptr) return std::nullopt;

  std::vector<std::uint8_t> out(cipher.size() + EVP_MAX_BLOCK_LENGTH);
  int length = 0;
  int total = 0;

  bool ok = EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, key_.data(),
                               iv.data()) == 1 &&
            EVP_DecryptUpdate(ctx, out.data(), &length, cipher.data(),
                              static_cast<int>(cipher.size())) == 1;
  if (ok) {
    total = length;
    // Setting the tag before Final is what makes the decrypt authenticated:
    // a tampered file fails here rather than yielding garbage.
    ok = EVP_CIPHER_CTX_ctrl(
             ctx, EVP_CTRL_GCM_SET_TAG, static_cast<int>(kTagSize),
             const_cast<std::uint8_t*>(tag.data())) == 1 &&
         EVP_DecryptFinal_ex(ctx, out.data() + total, &length) == 1;
    total += length;
  }
  EVP_CIPHER_CTX_free(ctx);

  if (!ok) return std::nullopt;
  return std::string(out.begin(), out.begin() + total);
}

SecureCredentials SecureStorage::get() const {
  std::lock_guard<std::mutex> lock(mutex_);

  SecureCredentials credentials;
  if (!available_) return credentials;

  std::ifstream file(credentials_path_);
  if (!file.is_open()) return credentials;

  Json envelope = Json::parse(file, nullptr, false);
  if (envelope.is_discarded() || !envelope.is_object()) return credentials;

  const auto plaintext =
      decrypt(from_hex(envelope.value("data", "")),
              from_hex(envelope.value("iv", "")),
              from_hex(envelope.value("tag", "")));

  if (!plaintext.has_value()) {
    Logger::instance().warn(
        "SecureStorage",
        "Credential store did not authenticate; treating it as empty");
    return credentials;
  }

  Json parsed = Json::parse(*plaintext, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) return credentials;

  const auto read = [&parsed](const char* key,
                              std::optional<std::string>& out) {
    if (parsed.contains(key) && parsed[key].is_string()) {
      out = parsed[key].get<std::string>();
    }
  };
  read("rpcUrl", credentials.rpc_url);
  read("privateKey", credentials.private_key);
  read("grpcUrl", credentials.grpc_url);
  read("authToken", credentials.auth_token);
  read("wsEndpoint", credentials.ws_endpoint);
  read("trackedWallets", credentials.tracked_wallets);

  return credentials;
}

void SecureStorage::save(const SecureCredentials& credentials) {
  std::lock_guard<std::mutex> lock(mutex_);

  if (!available_) {
    throw std::runtime_error("credential store is not writable: " +
                             config_dir_);
  }

  Json plain = Json::object();
  const auto write = [&plain](const char* key,
                              const std::optional<std::string>& value) {
    if (value.has_value()) plain[key] = *value;
  };
  write("rpcUrl", credentials.rpc_url);
  write("privateKey", credentials.private_key);
  write("grpcUrl", credentials.grpc_url);
  write("authToken", credentials.auth_token);
  write("wsEndpoint", credentials.ws_endpoint);
  write("trackedWallets", credentials.tracked_wallets);

  std::vector<std::uint8_t> iv;
  std::vector<std::uint8_t> tag;
  const auto cipher = encrypt(plain.dump(), iv, tag);

  const Json envelope = {{"version", 1},
                         {"iv", to_hex(iv)},
                         {"tag", to_hex(tag)},
                         {"data", to_hex(cipher)}};

  std::ofstream file(credentials_path_, std::ios::trunc);
  if (!file.is_open()) {
    throw std::runtime_error("could not write " + credentials_path_);
  }
  file << envelope.dump() << '\n';
  file.close();
  restrict_permissions(credentials_path_);
}

void SecureStorage::set(const std::string& field,
                        const std::optional<std::string>& value) {
  SecureCredentials credentials = get();

  if (field == "rpcUrl")              credentials.rpc_url = value;
  else if (field == "privateKey")     credentials.private_key = value;
  else if (field == "grpcUrl")        credentials.grpc_url = value;
  else if (field == "authToken")      credentials.auth_token = value;
  else if (field == "wsEndpoint")     credentials.ws_endpoint = value;
  else if (field == "trackedWallets") credentials.tracked_wallets = value;
  else return;

  save(credentials);
}

void SecureStorage::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::error_code ec;
  std::filesystem::remove(credentials_path_, ec);
}

}  // namespace eclipse::cli
