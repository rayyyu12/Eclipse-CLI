#include "eclipse/common/pubkey.hpp"

#include <openssl/bn.h>
#include <openssl/evp.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <stdexcept>

#include "eclipse/common/base58.hpp"

namespace eclipse {
namespace {

constexpr const char* kProgramDerivedAddressMarker = "ProgramDerivedAddress";

const Pubkey& associated_token_program_id() {
  static const Pubkey id("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  return id;
}

const Pubkey& token_program_id() {
  static const Pubkey id("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  return id;
}

struct BnDeleter {
  void operator()(BIGNUM* bn) const { BN_free(bn); }
};
using Bn = std::unique_ptr<BIGNUM, BnDeleter>;

struct BnCtxDeleter {
  void operator()(BN_CTX* ctx) const { BN_CTX_free(ctx); }
};
using BnCtx = std::unique_ptr<BN_CTX, BnCtxDeleter>;

Bn bn_from_hex(const char* hex) {
  BIGNUM* raw = nullptr;
  BN_hex2bn(&raw, hex);
  return Bn(raw);
}

/// True when the 32 bytes decompress to a point on ed25519.
///
/// Solana rejects on-curve results as program addresses, because a private key
/// could exist for them. The test is the standard decompression: recover x
/// from y and confirm it satisfies the curve equation
///
///     -x^2 + y^2 = 1 + d*x^2*y^2   (mod 2^255 - 19)
///
/// Done with BIGNUM rather than hand-rolled field arithmetic so the modular
/// inverse and exponentiation are constant-time and known-correct.
bool is_on_curve(const Pubkey::Bytes& bytes) {
  BnCtx ctx(BN_CTX_new());
  if (!ctx) return false;

  // p = 2^255 - 19
  static const char* kPHex =
      "7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFED";
  // d = -121665/121666 mod p
  static const char* kDHex =
      "52036CEE2B6FFE738CC740797779E89800700A4D4141D8AB75EB4DCA135978A3";

  const Bn p = bn_from_hex(kPHex);
  const Bn d = bn_from_hex(kDHex);
  if (!p || !d) return false;

  // The encoding is little-endian y with the top bit carrying x's sign.
  std::array<std::uint8_t, 32> le = {};
  std::copy(bytes.begin(), bytes.end(), le.begin());
  const bool x_is_odd = (le[31] & 0x80) != 0;
  le[31] &= 0x7F;

  std::array<std::uint8_t, 32> be{};
  std::reverse_copy(le.begin(), le.end(), be.begin());

  Bn y(BN_bin2bn(be.data(), static_cast<int>(be.size()), nullptr));
  if (!y) return false;

  // A y at or above p is not a canonical encoding.
  if (BN_cmp(y.get(), p.get()) >= 0) return false;

  Bn y2(BN_new()), u(BN_new()), v(BN_new()), tmp(BN_new());
  if (!y2 || !u || !v || !tmp) return false;

  BN_mod_sqr(y2.get(), y.get(), p.get(), ctx.get());

  // u = y^2 - 1
  BN_one(tmp.get());
  BN_mod_sub(u.get(), y2.get(), tmp.get(), p.get(), ctx.get());

  // v = d*y^2 + 1
  BN_mod_mul(v.get(), d.get(), y2.get(), p.get(), ctx.get());
  BN_one(tmp.get());
  BN_mod_add(v.get(), v.get(), tmp.get(), p.get(), ctx.get());

  // x^2 = u/v. A v of zero has no inverse, so the point does not exist.
  Bn v_inv(BN_new());
  if (!v_inv || BN_mod_inverse(v_inv.get(), v.get(), p.get(), ctx.get()) ==
                    nullptr) {
    return false;
  }

  Bn x2(BN_new());
  BN_mod_mul(x2.get(), u.get(), v_inv.get(), p.get(), ctx.get());

  // x = (x^2)^((p+3)/8), the square root candidate for p = 5 mod 8.
  Bn exponent(BN_new());
  BN_copy(exponent.get(), p.get());
  BN_add_word(exponent.get(), 3);
  BN_rshift(exponent.get(), exponent.get(), 3);

  Bn x(BN_new());
  BN_mod_exp(x.get(), x2.get(), exponent.get(), p.get(), ctx.get());

  // Confirm x^2 == x2; if not, multiply by sqrt(-1) and retry.
  Bn check(BN_new());
  BN_mod_sqr(check.get(), x.get(), p.get(), ctx.get());

  if (BN_cmp(check.get(), x2.get()) != 0) {
    // sqrt(-1) = 2^((p-1)/4) mod p
    Bn quarter(BN_new());
    BN_copy(quarter.get(), p.get());
    BN_sub_word(quarter.get(), 1);
    BN_rshift(quarter.get(), quarter.get(), 2);

    Bn two(BN_new());
    BN_set_word(two.get(), 2);

    Bn sqrt_m1(BN_new());
    BN_mod_exp(sqrt_m1.get(), two.get(), quarter.get(), p.get(), ctx.get());
    BN_mod_mul(x.get(), x.get(), sqrt_m1.get(), p.get(), ctx.get());

    BN_mod_sqr(check.get(), x.get(), p.get(), ctx.get());
    if (BN_cmp(check.get(), x2.get()) != 0) return false;  // no square root
  }

  // x == 0 with the sign bit set is the one encoding with no valid point.
  if (BN_is_zero(x.get()) && x_is_odd) return false;

  return true;
}

/// SHA-256 through the EVP interface. The low-level SHA256_* calls are
/// deprecated in OpenSSL 3.
Pubkey::Bytes sha256(const std::vector<std::uint8_t>& input) {
  Pubkey::Bytes digest{};
  unsigned int len = 0;
  EVP_Digest(input.data(), input.size(), digest.data(), &len, EVP_sha256(),
             nullptr);
  return digest;
}

}  // namespace

Pubkey::Pubkey(const std::string& base58_text) {
  auto decoded = base58::decode(base58_text);
  if (!decoded.has_value() || decoded->size() != kSize) {
    throw std::invalid_argument("invalid public key: " + base58_text);
  }
  std::copy(decoded->begin(), decoded->end(), bytes_.begin());
}

std::optional<Pubkey> Pubkey::try_parse(const std::string& base58_text) {
  auto decoded = base58::decode(base58_text);
  if (!decoded.has_value() || decoded->size() != kSize) return std::nullopt;
  Bytes bytes{};
  std::copy(decoded->begin(), decoded->end(), bytes.begin());
  return Pubkey(bytes);
}

std::string Pubkey::to_base58() const {
  return base58::encode(bytes_.data(), bytes_.size());
}

bool Pubkey::is_default() const {
  return std::all_of(bytes_.begin(), bytes_.end(),
                     [](std::uint8_t b) { return b == 0; });
}

std::optional<Pubkey> Pubkey::create_program_address(
    const std::vector<std::vector<std::uint8_t>>& seeds,
    const Pubkey& program_id) {
  std::vector<std::uint8_t> buffer;
  buffer.reserve(seeds.size() * 32 + kSize + 24);

  for (const auto& seed : seeds) {
    if (seed.size() > 32) return std::nullopt;  // max seed length
    buffer.insert(buffer.end(), seed.begin(), seed.end());
  }
  buffer.insert(buffer.end(), program_id.data(), program_id.data() + kSize);
  buffer.insert(buffer.end(), kProgramDerivedAddressMarker,
                kProgramDerivedAddressMarker +
                    std::strlen(kProgramDerivedAddressMarker));

  const Bytes digest = sha256(buffer);
  if (is_on_curve(digest)) return std::nullopt;
  return Pubkey(digest);
}

std::optional<std::pair<Pubkey, std::uint8_t>> Pubkey::find_program_address(
    const std::vector<std::vector<std::uint8_t>>& seeds,
    const Pubkey& program_id) {
  for (int bump = 255; bump >= 0; --bump) {
    auto bumped = seeds;
    bumped.push_back({static_cast<std::uint8_t>(bump)});

    auto derived = create_program_address(bumped, program_id);
    if (derived.has_value()) {
      return std::make_pair(*derived, static_cast<std::uint8_t>(bump));
    }
  }
  return std::nullopt;
}

Pubkey Pubkey::associated_token_address(const Pubkey& wallet,
                                        const Pubkey& mint) {
  const auto to_seed = [](const Pubkey& key) {
    return std::vector<std::uint8_t>(key.bytes().begin(), key.bytes().end());
  };

  auto derived = find_program_address(
      {to_seed(wallet), to_seed(token_program_id()), to_seed(mint)},
      associated_token_program_id());

  // Every (wallet, mint) pair has a valid ATA; a miss would mean all 256 bumps
  // landed on the curve, which cannot happen in practice.
  if (!derived.has_value()) {
    throw std::runtime_error("could not derive associated token address");
  }
  return derived->first;
}

}  // namespace eclipse
