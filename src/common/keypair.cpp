#include "eclipse/common/keypair.hpp"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <stdexcept>

#include "eclipse/common/base58.hpp"

namespace eclipse {
namespace {

struct EvpKeyDeleter {
  void operator()(EVP_PKEY* key) const { EVP_PKEY_free(key); }
};
using EvpKey = std::unique_ptr<EVP_PKEY, EvpKeyDeleter>;

struct MdCtxDeleter {
  void operator()(EVP_MD_CTX* ctx) const { EVP_MD_CTX_free(ctx); }
};
using MdCtx = std::unique_ptr<EVP_MD_CTX, MdCtxDeleter>;

/// Derives the public half from the 32-byte seed.
Pubkey derive_pubkey(const std::uint8_t* seed) {
  EvpKey key(EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr, seed,
                                          Keypair::kSeedSize));
  if (!key) throw std::invalid_argument("invalid ed25519 seed");

  Pubkey::Bytes out{};
  std::size_t len = out.size();
  if (EVP_PKEY_get_raw_public_key(key.get(), out.data(), &len) != 1 ||
      len != out.size()) {
    throw std::invalid_argument("could not derive public key from seed");
  }
  return Pubkey(out);
}

void secure_zero(std::vector<std::uint8_t>& buffer) {
  if (buffer.empty()) return;
  OPENSSL_cleanse(buffer.data(), buffer.size());
}

}  // namespace

Keypair Keypair::generate() {
  std::vector<std::uint8_t> seed(kSeedSize);
  if (RAND_bytes(seed.data(), static_cast<int>(seed.size())) != 1) {
    throw std::runtime_error("could not read random bytes for a new keypair");
  }

  Keypair out;
  out.pubkey_ = derive_pubkey(seed.data());

  // Store in the seed || public key layout the rest of the code expects.
  out.secret_.resize(kSecretSize);
  std::copy(seed.begin(), seed.end(), out.secret_.begin());
  std::copy(out.pubkey_.bytes().begin(), out.pubkey_.bytes().end(),
            out.secret_.begin() + kSeedSize);

  secure_zero(seed);
  return out;
}

Keypair Keypair::from_secret_key(const std::vector<std::uint8_t>& secret) {
  if (secret.size() != kSecretSize) {
    throw std::invalid_argument("secret key must be 64 bytes");
  }

  Keypair out;
  out.secret_ = secret;
  out.pubkey_ = derive_pubkey(secret.data());

  // Bytes 32..64 carry the public key. A mismatch means the blob is corrupt or
  // came from a different curve, and signing with it would produce garbage.
  if (!std::equal(secret.begin() + kSeedSize, secret.end(),
                  out.pubkey_.bytes().begin())) {
    throw std::invalid_argument("secret key does not match its public key");
  }
  return out;
}

Keypair Keypair::from_base58_secret(const std::string& base58_secret) {
  auto decoded = base58::decode(base58_secret);
  if (!decoded.has_value()) {
    throw std::invalid_argument("private key is not valid base58");
  }
  return from_secret_key(*decoded);
}

Keypair Keypair::from_json_array(const std::string& json_array) {
  // Parsed by hand so the secret never lands in a JSON library's arena.
  std::vector<std::uint8_t> bytes;
  bytes.reserve(kSecretSize);

  int value = -1;
  for (char c : json_array) {
    if (c >= '0' && c <= '9') {
      value = (value < 0 ? 0 : value * 10) + (c - '0');
      if (value > 255) throw std::invalid_argument("byte out of range");
    } else if (value >= 0) {
      bytes.push_back(static_cast<std::uint8_t>(value));
      value = -1;
    }
  }
  if (value >= 0) bytes.push_back(static_cast<std::uint8_t>(value));

  return from_secret_key(bytes);
}

std::array<std::uint8_t, Keypair::kSignatureSize> Keypair::sign(
    const std::uint8_t* message, std::size_t len) const {
  if (secret_.size() != kSecretSize) {
    throw std::runtime_error("cannot sign with an uninitialised keypair");
  }

  EvpKey key(EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr,
                                          secret_.data(), kSeedSize));
  if (!key) throw std::runtime_error("could not load signing key");

  MdCtx ctx(EVP_MD_CTX_new());
  if (!ctx) throw std::runtime_error("could not allocate signing context");

  if (EVP_DigestSignInit(ctx.get(), nullptr, nullptr, nullptr, key.get()) != 1) {
    throw std::runtime_error("could not initialise ed25519 signing");
  }

  std::array<std::uint8_t, kSignatureSize> signature{};
  std::size_t sig_len = signature.size();

  // Ed25519 is a one-shot algorithm: EVP_DigestSign does the whole message.
  if (EVP_DigestSign(ctx.get(), signature.data(), &sig_len, message, len) != 1 ||
      sig_len != signature.size()) {
    throw std::runtime_error("ed25519 signing failed");
  }
  return signature;
}

std::array<std::uint8_t, Keypair::kSignatureSize> Keypair::sign(
    const std::vector<std::uint8_t>& message) const {
  return sign(message.data(), message.size());
}

Keypair::~Keypair() { secure_zero(secret_); }

}  // namespace eclipse
