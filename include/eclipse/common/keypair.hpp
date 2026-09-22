#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include "eclipse/common/pubkey.hpp"

namespace eclipse {

/// An ed25519 signing key. The 64-byte secret is the seed followed by the
/// public key, which is the layout @solana/web3.js writes out.
class Keypair {
 public:
  static constexpr std::size_t kSecretSize = 64;
  static constexpr std::size_t kSeedSize = 32;
  static constexpr std::size_t kSignatureSize = 64;

  Keypair() = default;

  /// A fresh random key. Used for the throwaway wrapped-SOL account a swap
  /// creates and closes within one transaction.
  static Keypair generate();

  /// Throws std::invalid_argument when the secret is not 64 bytes or the
  /// embedded public key does not match the seed.
  static Keypair from_secret_key(const std::vector<std::uint8_t>& secret);

  /// Accepts the base58 form a wallet exports.
  static Keypair from_base58_secret(const std::string& base58_secret);

  /// Accepts the JSON byte-array form the TypeScript build persisted.
  static Keypair from_json_array(const std::string& json_array);

  const Pubkey& pubkey() const { return pubkey_; }

  /// Zeroised on destruction.
  const std::vector<std::uint8_t>& secret() const { return secret_; }

  std::array<std::uint8_t, kSignatureSize> sign(
      const std::uint8_t* message, std::size_t len) const;

  std::array<std::uint8_t, kSignatureSize> sign(
      const std::vector<std::uint8_t>& message) const;

  ~Keypair();

  Keypair(const Keypair&) = default;
  Keypair& operator=(const Keypair&) = default;

 private:
  std::vector<std::uint8_t> secret_;
  Pubkey pubkey_;
};

}  // namespace eclipse
