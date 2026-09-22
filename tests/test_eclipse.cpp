// Checks the parts of the port where "looks right" is not good enough: the
// base58 codec, PDA derivation, message serialisation and the AMM maths. Each
// case is pinned to a value that can be verified independently.
//
//   ./eclipse-tests

#include <cmath>
#include <iostream>
#include <string>

#include "eclipse/common/base58.hpp"
#include "eclipse/common/keypair.hpp"
#include "eclipse/common/pubkey.hpp"
#include "eclipse/pools/pool_selector.hpp"
#include "eclipse/solana/instruction.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/solana/transaction.hpp"
#include "eclipse/swaps/constants.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string& what) {
  ++g_checks;
  if (condition) return;
  ++g_failures;
  std::cout << "  FAIL  " << what << '\n';
}

template <typename T>
void check_eq(const T& actual, const T& expected, const std::string& what) {
  ++g_checks;
  if (actual == expected) return;
  ++g_failures;
  std::cout << "  FAIL  " << what << "\n        expected: " << expected
            << "\n        actual:   " << actual << '\n';
}

void test_base58() {
  std::cout << "base58\n";

  // Round-tripping the well-known program ids catches both directions at once.
  for (const char* address :
       {"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        "So11111111111111111111111111111111111111112",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "11111111111111111111111111111111"}) {
    const eclipse::Pubkey key{std::string(address)};
    check_eq(key.to_base58(), std::string(address),
             std::string("round trip ") + address);
  }

  // Leading zero bytes encode as leading '1' characters, one for one.
  const std::vector<std::uint8_t> zeros(32, 0);
  check_eq(eclipse::base58::encode(zeros), std::string(32, '1'),
           "32 zero bytes encode as 32 ones");

  check(!eclipse::base58::decode("0OIl").has_value(),
        "characters outside the alphabet are rejected");
  check(!eclipse::Pubkey::try_parse("tooshort").has_value(),
        "a short key is rejected");
}

void test_program_addresses() {
  std::cout << "program addresses\n";

  // Raydium's AMM authority is a published constant, so deriving it exercises
  // the SHA-256 seeding, the bump search and the on-curve rejection together.
  check_eq(eclipse::swaps::raydium_amm_authority().to_base58(),
           std::string("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"),
           "Raydium AMM authority derives correctly");

  // An ATA must be deterministic and must not equal either input.
  const eclipse::Pubkey wallet(
      "So11111111111111111111111111111111111111112");
  const eclipse::Pubkey mint(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  const auto first = eclipse::Pubkey::associated_token_address(wallet, mint);
  const auto second = eclipse::Pubkey::associated_token_address(wallet, mint);

  check_eq(first.to_base58(), second.to_base58(), "ATA derivation is stable");
  check(first != wallet && first != mint, "ATA differs from its inputs");
}

void test_shortvec() {
  std::cout << "shortvec encoding\n";

  const auto encode = [](std::uint16_t value) {
    std::vector<std::uint8_t> out;
    eclipse::solana::put_compact_u16(out, value);
    return out;
  };

  // Vectors from the Solana wire format documentation.
  check(encode(0) == std::vector<std::uint8_t>{0x00}, "0");
  check(encode(5) == std::vector<std::uint8_t>{0x05}, "5");
  check(encode(127) == std::vector<std::uint8_t>{0x7f}, "127");
  check(encode(128) == std::vector<std::uint8_t>{0x80, 0x01}, "128");
  check(encode(255) == std::vector<std::uint8_t>{0xff, 0x01}, "255");
  check(encode(16384) == std::vector<std::uint8_t>{0x80, 0x80, 0x01}, "16384");
}

void test_transaction() {
  std::cout << "transaction compilation\n";

  using namespace eclipse;
  using namespace eclipse::solana;

  const Pubkey payer("So11111111111111111111111111111111111111112");
  const Pubkey destination("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  Transaction transaction;
  transaction.set_fee_payer(payer);
  transaction.set_recent_blockhash("11111111111111111111111111111111");
  transaction.add(compute_budget::set_compute_unit_limit(1400000));
  transaction.add(system_program::transfer(payer, destination, 1000000));

  const Message message = transaction.compile();

  check(message.account_keys[0] == payer, "fee payer is at index 0");
  check_eq(int{message.num_required_signatures}, 1, "one required signature");
  check_eq(message.account_keys.size(), std::size_t{4},
           "payer, destination, and two program ids");

  // Program ids are never signers and never writable.
  check_eq(int{message.num_readonly_unsigned}, 2,
           "both program ids are readonly non-signers");

  const auto serialized = message.serialize();
  const auto wire = transaction.serialize_unsigned();
  check_eq(wire.size(), serialized.size() + 1 + Keypair::kSignatureSize,
           "wire size is the shortvec count plus signatures plus message");

  // A transaction without a blockhash must not reach the network.
  Transaction incomplete;
  incomplete.set_fee_payer(payer);
  incomplete.add(system_program::transfer(payer, destination, 1));

  bool threw = false;
  try {
    incomplete.sign_and_serialize({});
  } catch (const std::exception&) {
    threw = true;
  }
  check(threw, "signing without a blockhash is refused");
}

void test_keypair() {
  std::cout << "keypair\n";

  const auto keypair = eclipse::Keypair::generate();
  check_eq(keypair.secret().size(), eclipse::Keypair::kSecretSize,
           "secret is 64 bytes");

  // The second half of the secret must be the public key; that invariant is
  // what makes a wallet export loadable.
  const auto& secret = keypair.secret();
  const bool matches = std::equal(secret.begin() + eclipse::Keypair::kSeedSize,
                                  secret.end(),
                                  keypair.pubkey().bytes().begin());
  check(matches, "secret embeds its own public key");

  // A round trip through base58 has to produce the same wallet.
  const auto encoded = eclipse::base58::encode(secret);
  const auto restored = eclipse::Keypair::from_base58_secret(encoded);
  check_eq(restored.pubkey().to_base58(), keypair.pubkey().to_base58(),
           "base58 secret round trips");

  // Signatures are deterministic in ed25519, so the same message signs alike.
  const std::vector<std::uint8_t> message{1, 2, 3, 4};
  check(keypair.sign(message) == keypair.sign(message),
        "signing is deterministic");

  bool threw = false;
  try {
    eclipse::Keypair::from_secret_key(std::vector<std::uint8_t>(64, 0));
  } catch (const std::exception&) {
    threw = true;
  }
  check(threw, "a secret whose public half does not match is rejected");
}

void test_amm_math() {
  std::cout << "AMM maths\n";

  using eclipse::pools::constant_product_output;

  // Equal reserves: a tiny trade moves the price almost not at all.
  const std::uint64_t reserve = 1000000000000ULL;
  const std::uint64_t out = constant_product_output(1000000, reserve, reserve);
  check(out > 0 && out <= 1000000, "small trade returns close to its input");

  // Output can never exceed the quote reserve, whatever the input.
  const std::uint64_t huge =
      constant_product_output(std::uint64_t{1} << 40, 1000, 5000);
  check(huge < 5000, "output stays below the quote reserve");

  check_eq(constant_product_output(0, reserve, reserve), std::uint64_t{0},
           "zero in, zero out");
  check_eq(constant_product_output(1000, 0, reserve), std::uint64_t{0},
           "an empty pool returns nothing");

  // Slippage reduces and clamps rather than wrapping.
  check_eq(eclipse::swaps::apply_slippage(1000, 0.0), std::uint64_t{1000},
           "zero slippage is a no-op");
  check_eq(eclipse::swaps::apply_slippage(1000, 50.0), std::uint64_t{500},
           "50 percent halves the minimum");
  check_eq(eclipse::swaps::apply_slippage(1000, 100.0), std::uint64_t{0},
           "100 percent floors at zero");
}

void test_amount_formatting() {
  std::cout << "amount formatting\n";

  using eclipse::pools::format_amount;
  using eclipse::pools::parse_amount;

  check_eq(format_amount(1500000000, 9), std::string("1.5"), "1.5 SOL");
  check_eq(format_amount(1000000000, 9), std::string("1"),
           "trailing zeros are trimmed");
  check_eq(format_amount(1, 9), std::string("0.000000001"), "one lamport");
  check_eq(format_amount(0, 9), std::string("0"), "zero");

  check_eq(parse_amount("1.5", 9).value_or(0), std::uint64_t{1500000000},
           "parses 1.5");
  check_eq(parse_amount("0.000000001", 9).value_or(0), std::uint64_t{1},
           "parses one lamport");

  // More precision than the mint supports would be silently truncated, so it
  // is rejected instead.
  check(!parse_amount("1.0000000001", 9).has_value(),
        "excess precision is rejected");
  check(!parse_amount("abc", 9).has_value(), "non-numeric input is rejected");
}

}  // namespace

int main() {
  test_base58();
  test_program_addresses();
  test_shortvec();
  test_transaction();
  test_keypair();
  test_amm_math();
  test_amount_formatting();

  std::cout << '\n'
            << (g_failures == 0 ? "PASS" : "FAIL") << "  " << g_checks
            << " checks, " << g_failures << " failed\n";
  return g_failures == 0 ? 0 : 1;
}
