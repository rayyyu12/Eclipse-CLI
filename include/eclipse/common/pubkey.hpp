#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace eclipse {

/// A 32-byte Solana account address.
class Pubkey {
 public:
  static constexpr std::size_t kSize = 32;
  using Bytes = std::array<std::uint8_t, kSize>;

  Pubkey() : bytes_{} {}
  explicit Pubkey(const Bytes& bytes) : bytes_(bytes) {}

  /// Throws std::invalid_argument when the string is not 32 base58 bytes.
  explicit Pubkey(const std::string& base58_text);

  static std::optional<Pubkey> try_parse(const std::string& base58_text);

  const Bytes& bytes() const { return bytes_; }
  const std::uint8_t* data() const { return bytes_.data(); }

  std::string to_base58() const;
  std::string to_string() const { return to_base58(); }

  bool is_default() const;

  bool operator==(const Pubkey& other) const { return bytes_ == other.bytes_; }
  bool operator!=(const Pubkey& other) const { return !(*this == other); }
  bool operator<(const Pubkey& other) const { return bytes_ < other.bytes_; }

  /// Derives a program address from seeds, bumping until the result falls off
  /// the ed25519 curve. Mirrors PublicKey.findProgramAddress.
  static std::optional<std::pair<Pubkey, std::uint8_t>> find_program_address(
      const std::vector<std::vector<std::uint8_t>>& seeds,
      const Pubkey& program_id);

  /// Single-shot derivation with no bump search. Mirrors
  /// PublicKey.createProgramAddress: fails if the result is on the curve.
  static std::optional<Pubkey> create_program_address(
      const std::vector<std::vector<std::uint8_t>>& seeds,
      const Pubkey& program_id);

  /// The SPL associated-token-account address for (wallet, mint).
  static Pubkey associated_token_address(const Pubkey& wallet,
                                         const Pubkey& mint);

 private:
  Bytes bytes_;
};

}  // namespace eclipse

namespace std {
template <>
struct hash<eclipse::Pubkey> {
  std::size_t operator()(const eclipse::Pubkey& key) const noexcept {
    // The address is already a hash; fold its first word.
    std::size_t out = 0;
    const auto& b = key.bytes();
    for (std::size_t i = 0; i < sizeof(std::size_t) && i < b.size(); ++i) {
      out = (out << 8) | b[i];
    }
    return out;
  }
};
}  // namespace std
