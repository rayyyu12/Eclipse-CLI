// Checks the parts of the port where "looks right" is not good enough: the
// base58 codec, PDA derivation, message serialisation, the AMM maths, and the
// copy trader's decoding, filters and sizing. Each case is pinned to a value
// that can be verified independently.
//
//   ./eclipse-tests

#include <cmath>
#include <iostream>
#include <string>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/base58.hpp"
#include "eclipse/common/keypair.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/common/pubkey.hpp"
#include "eclipse/copytrade/copy_executor.hpp"
#include "eclipse/copytrade/copy_swap.hpp"
#include "eclipse/copytrade/copy_trade_logger.hpp"
#include "eclipse/copytrade/transaction_monitor.hpp"
#include "eclipse/copytrade/transaction_parser.hpp"
#include "eclipse/pools/pool_selector.hpp"
#include "eclipse/solana/instruction.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/solana/transaction.hpp"
#include "eclipse/swaps/constants.hpp"
#include "eclipse/swaps/pump_swap.hpp"
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

// --- Copy trading ------------------------------------------------------------------
//
// Synthetic transactions, laid out the way Yellowstone delivers them, run
// through the decoder. No network.

namespace ct = eclipse::copytrade;

/// A distinct, recognisable key: every byte is `n`.
eclipse::Pubkey key_of(std::uint8_t n) {
  eclipse::Pubkey::Bytes bytes;
  bytes.fill(n);
  return eclipse::Pubkey(bytes);
}

ct::TokenBalance balance_of(std::uint32_t index, const eclipse::Pubkey& mint,
                            const eclipse::Pubkey& owner, double ui,
                            std::uint32_t decimals) {
  ct::TokenBalance balance;
  balance.account_index = index;
  balance.mint = mint.to_base58();
  balance.owner = owner.to_base58();
  balance.ui_token_amount.ui_amount = ui;
  balance.ui_token_amount.decimals = decimals;
  return balance;
}

std::vector<std::uint8_t> pump_data(const std::uint8_t (&discriminator)[8]) {
  std::vector<std::uint8_t> data(std::begin(discriminator),
                                 std::end(discriminator));
  eclipse::solana::put_u64(data, 1000);
  eclipse::solana::put_u64(data, 2000);
  return data;
}

/// A followed wallet buying on pump.fun: 0.5 SOL out of the fee payer, 1000
/// tokens into its new token account.
ct::TransactionUpdate pump_trade(bool as_cpi,
                                 const std::uint8_t (&discriminator)[8]) {
  using eclipse::swaps::pump_fun_program_id;

  ct::TransactionUpdate tx;
  tx.signature = "sig-pump";
  // 0 wallet, 1 user ATA, 2 curve, 3 curve ATA, 4 global, 5 fee recipient,
  // 6 mint, 7 router, 8 pump.fun
  tx.account_keys = {key_of(10), key_of(11), key_of(12), key_of(13),
                     key_of(14), key_of(15), key_of(16), key_of(17),
                     pump_fun_program_id()};

  ct::CompiledInstruction pump;
  pump.program_id_index = 8;
  pump.accounts = {4, 5, 6, 2, 3, 1, 0};
  pump.data = pump_data(discriminator);

  if (as_cpi) {
    ct::CompiledInstruction router;
    router.program_id_index = 7;
    tx.instructions = {router};
    tx.inner_instructions = {ct::InnerInstructions{0, {pump}}};
  } else {
    tx.instructions = {pump};
  }

  tx.log_messages = {"Program " + pump_fun_program_id().to_base58() +
                     " invoke [1]"};
  tx.pre_balances = {2000000000, 0, 0, 0, 0, 0, 0, 0, 0};
  tx.post_balances = {1500000000, 0, 0, 0, 0, 0, 0, 0, 0};
  tx.post_token_balances = {balance_of(1, key_of(16), key_of(10), 1000.0, 6)};
  return tx;
}

void test_copy_trade_filters() {
  std::cout << "copy trade stream filters\n";

  const std::string pump = eclipse::swaps::pump_fun_program_id().to_base58();
  const std::string raydium =
      eclipse::swaps::raydium_amm_program_id().to_base58();
  const std::vector<std::string> wallets = {key_of(1).to_base58(),
                                            key_of(2).to_base58()};

  // account_required is AND within a filter, so each wallet needs its own.
  const auto filters = ct::build_transaction_filters(wallets, true, true);
  check_eq(filters.size(), std::size_t{2}, "one filter per followed wallet");

  bool shaped = filters.size() == 2;
  for (std::size_t i = 0; shaped && i < filters.size(); ++i) {
    const auto& filter = filters[i];
    shaped = filter.account_required == std::vector<std::string>{wallets[i]} &&
             filter.account_include ==
                 std::vector<std::string>{pump, raydium} &&
             !filter.vote && !filter.failed;
  }
  check(shaped,
        "each filter requires its one wallet, includes both programs, and "
        "excludes votes and failures");
  check(filters.size() == 2 && filters[0].name != filters[1].name,
        "filter names are unique");

  const auto raydium_only = ct::build_transaction_filters(wallets, false, true);
  check(!raydium_only.empty() &&
            raydium_only[0].account_include ==
                std::vector<std::string>{raydium},
        "a disabled venue is left out of account_include");
  check(ct::build_transaction_filters(wallets, false, false).empty(),
        "no venues, no filters");
}

void test_copy_trade_pump_decoding() {
  std::cout << "copy trade pump.fun decoding\n";

  using eclipse::swaps::kPumpBuyDiscriminator;
  using eclipse::swaps::kPumpSellDiscriminator;
  const std::string wallet = key_of(10).to_base58();

  const auto buy = ct::parse_swap(pump_trade(false, kPumpBuyDiscriminator),
                                  wallet);
  check(buy.has_value() && ct::type_of(*buy) == ct::SwapType::Pump,
        "a pump.fun buy decodes as pump.fun");
  if (buy.has_value()) {
    const auto& data = std::get<ct::PumpSwapData>(*buy);
    check(data.is_buy, "buy discriminator reads as a buy");
    check(data.token_address == key_of(16), "mint is account slot 2");
    check(data.bonding_curve == key_of(12), "curve is account slot 3");
    check(std::abs(data.amount_in - 0.5) < 1e-12,
          "SOL in is the fee payer's lamport delta");
    check(std::abs(data.amount_out - 1000.0) < 1e-9,
          "tokens out is the mint's balance delta");
    check(data.success, "a transaction without err is a success");
  }

  check(ct::parse_swap(pump_trade(true, kPumpBuyDiscriminator), wallet)
            .has_value(),
        "a buy made through a CPI is found in the inner instructions");

  const auto sell =
      ct::parse_swap(pump_trade(false, kPumpSellDiscriminator), wallet);
  check(sell.has_value() && !ct::base_of(*sell).is_buy &&
            std::abs(ct::base_of(*sell).amount_in - 1000.0) < 1e-9,
        "a sell's input is the token amount");

  const std::uint8_t other[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  check(!ct::parse_swap(pump_trade(false, other), wallet).has_value(),
        "a pump.fun instruction that is neither buy nor sell is ignored");

  auto unrelated = pump_trade(false, kPumpBuyDiscriminator);
  unrelated.log_messages = {"Program 11111111111111111111111111111111 invoke"};
  check(!ct::parse_swap(unrelated, wallet).has_value(),
        "no pump.fun or ray_log line, no swap");
}

void test_copy_trade_raydium_decoding() {
  std::cout << "copy trade Raydium decoding\n";

  using eclipse::solana::native_mint;
  const auto wallet = key_of(40);
  const auto token = key_of(41);

  ct::TransactionUpdate tx;
  tx.signature = "sig-raydium";
  // 0 wallet, 1-14 pool and market, 15 user WSOL, 16 user token,
  // 17 token program, 18 Raydium
  tx.account_keys = {wallet};
  for (std::uint8_t i = 1; i <= 16; ++i) tx.account_keys.push_back(key_of(i));
  tx.account_keys.push_back(eclipse::solana::token_program_id());
  tx.account_keys.push_back(eclipse::swaps::raydium_amm_program_id());

  ct::CompiledInstruction swap;
  swap.program_id_index = 18;
  swap.accounts = {17, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0};
  tx.instructions = {swap};
  tx.log_messages = {"Program log: ray_log: AwBA"};

  // A pool whose coin vault (5) holds WSOL: the buyer's SOL goes in there
  // and tokens leave the pc vault (6).
  tx.pre_token_balances = {balance_of(5, native_mint(), key_of(2), 100.0, 9),
                           balance_of(6, token, key_of(2), 5000.0, 6),
                           balance_of(15, native_mint(), wallet, 2.0, 9),
                           balance_of(16, token, wallet, 0.0, 6)};
  tx.post_token_balances = {balance_of(5, native_mint(), key_of(2), 101.0, 9),
                            balance_of(6, token, key_of(2), 4950.0, 6),
                            balance_of(15, native_mint(), wallet, 1.0, 9),
                            balance_of(16, token, wallet, 50.0, 6)};

  const auto parsed = ct::parse_swap(tx, wallet.to_base58());
  check(parsed.has_value() && ct::type_of(*parsed) == ct::SwapType::Raydium,
        "a ray_log transaction decodes as Raydium");
  if (!parsed.has_value()) return;

  const auto& data = std::get<ct::RaydiumSwapData>(*parsed);
  check(data.pool.amm_id == key_of(1) &&
            data.pool.pool_coin_token_account == key_of(5) &&
            data.pool.serum_vault_signer == key_of(14),
        "pool accounts come from SwapBaseIn's fixed slots");
  check(data.token_address == token, "the non-WSOL mint is the token");
  check(data.is_buy, "coin (WSOL) in and pc (token) out reads as a buy");
  check(data.token_in_mint == native_mint().to_base58() &&
            data.token_out_mint == token.to_base58(),
        "a buy goes from WSOL to the token");
  check(std::abs(data.pool_balances.coin.pre - 100.0) < 1e-12 &&
            std::abs(data.pool_balances.pc.post - 4950.0) < 1e-9,
        "vault balances are read before and after");
  check(data.ray_log_data == "AwBA", "ray_log payload is kept");

  // With vaults that did not move, the direction falls back to the net WSOL
  // change across every balance. Here the pool gained the 1 WSOL the wallet
  // lost, so the net is zero, which that fallback reads as a sell.
  ct::PoolBalances flat;
  check(ct::detect_swap_direction(tx.pre_token_balances,
                                  tx.post_token_balances,
                                  flat) == ct::SwapDirection::Sell,
        "net WSOL across all balances is zero here, which reads as a sell");
}

void test_copy_trade_pump_instructions() {
  std::cout << "copy trade pump.fun instructions\n";

  using namespace eclipse;
  swaps::PumpTradeAccounts accounts{key_of(1), key_of(2), key_of(3),
                                    key_of(4), key_of(5)};

  const auto buy = swaps::build_pump_buy_instruction(accounts, 1000, 2000);
  const auto sell = swaps::build_pump_sell_instruction(accounts, 1000, 500);

  check_eq(buy.accounts.size(), std::size_t{12}, "buy has 12 accounts");
  check_eq(sell.accounts.size(), std::size_t{12}, "sell has 12 accounts");

  // The IDL's two layouts diverge after the system program.
  check(buy.accounts[8].pubkey == solana::token_program_id() &&
            buy.accounts[9].pubkey == solana::rent_sysvar_id(),
        "buy: token program, then rent");
  check(sell.accounts[8].pubkey == solana::associated_token_program_id() &&
            sell.accounts[9].pubkey == solana::token_program_id(),
        "sell: associated token program, then token program");
  check(sell.accounts[6].is_signer && sell.accounts[6].pubkey == key_of(4),
        "the user signs");

  check_eq(solana::read_u64(sell.data, 8), std::uint64_t{1000},
           "sell amount follows the discriminator");
  check_eq(solana::read_u64(sell.data, 16), std::uint64_t{500},
           "then the minimum SOL out");
}

void test_copy_trade_sizing() {
  std::cout << "copy trade sizing and settings\n";

  using eclipse::cli::BuyMode;
  using eclipse::cli::CopyTradeSettings;

  CopyTradeSettings settings;
  check(eclipse::cli::validate_copy_trade_settings(settings).empty(),
        "the defaults validate");

  CopyTradeSettings inverted = settings;
  inverted.min_buy_amount = 5.0;
  inverted.max_buy_amount = 1.0;
  check(!eclipse::cli::validate_copy_trade_settings(inverted).empty(),
        "a minimum above the maximum is refused");

  check_eq(ct::resolve_buy_lamports(settings, 3.0).value_or(0),
           std::uint64_t{100000}, "fixed mode spends the fixed amount");

  CopyTradeSettings mirror = settings;
  mirror.buy_mode = BuyMode::Mirror;
  check_eq(ct::resolve_buy_lamports(mirror, 0.25).value_or(0),
           std::uint64_t{250000000}, "mirror mode spends what they spent");

  mirror.max_buy_amount = 0.1;
  std::string error;
  check(!ct::resolve_buy_lamports(mirror, 0.25, &error).has_value() &&
            !error.empty(),
        "a mirrored buy over the maximum is refused with a reason");

  // calculateSwapOutput, pinned: 1 SOL against vaults of 1000 and 10 with
  // the buy-side decimals of 9 gives 1e7 * 1e-4 = 1000, and 50% slippage
  // plus the 0.3% fee buffer floors that at 497.
  ct::PoolBalances vaults;
  vaults.coin.pre = 1000.0;
  vaults.pc.pre = 10.0;
  const auto quote = ct::quote_raydium_copy(1000000000, vaults, 9, 50.0);
  check(quote.has_value() && quote->expected_output == 1000 &&
            quote->min_amount_out == 497,
        "Raydium copy quote matches the TypeScript formula");
  check(!ct::quote_raydium_copy(1000, ct::PoolBalances{}, 9, 50.0).has_value(),
        "no coin vault balance, no quote");

  check_eq(eclipse::swaps::apply_slippage_ceiling(1000, 10.0),
           std::uint64_t{1100}, "slippage widens a cost ceiling");
  check_eq(ct::to_raw_amount(1.5, 6), std::uint64_t{1500000},
           "UI to raw amount");
}

void test_copy_trade_logger() {
  std::cout << "copy trade log\n";

  auto& feed = ct::CopyTradeLogger::instance();
  feed.clear();

  int seen = 0;
  const int listener =
      feed.subscribe([&seen](const ct::CopyTradeLog&) { ++seen; });
  feed.add(ct::CopyLogType::Info, "pump", "one");
  feed.add(ct::CopyLogType::Success, "pump", "two");
  feed.add(ct::CopyLogType::Error, "raydium", "three");
  feed.unsubscribe(listener);
  feed.add(ct::CopyLogType::Info, "system", "four");

  check_eq(seen, 3, "listeners see entries until they unsubscribe");
  const auto last_two = feed.get(2);
  check(last_two.size() == 2 && last_two[0].message == "three" &&
            last_two[1].message == "four",
        "get(n) returns the newest n, oldest first");
  feed.clear();
  check(feed.get().empty(), "clear empties the log");

  eclipse::swaps::StageTimer timer;
  timer.mark("a");
  timer.mark("b");
  check_eq(timer.stages().size(), std::size_t{2}, "one timing per mark");
}

}  // namespace

int main() {
  // The copy trade log mirrors into the main logger; keep it off the console.
  eclipse::Logger::instance().set_console_logging(false);
  eclipse::Logger::instance().set_file_logging(false);

  test_base58();
  test_program_addresses();
  test_shortvec();
  test_transaction();
  test_keypair();
  test_amm_math();
  test_amount_formatting();
  test_copy_trade_filters();
  test_copy_trade_pump_decoding();
  test_copy_trade_raydium_decoding();
  test_copy_trade_pump_instructions();
  test_copy_trade_sizing();
  test_copy_trade_logger();

  std::cout << '\n'
            << (g_failures == 0 ? "PASS" : "FAIL") << "  " << g_checks
            << " checks, " << g_failures << " failed\n";
  return g_failures == 0 ? 0 : 1;
}
