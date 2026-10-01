#include "eclipse/swaps/swap_builder.hpp"

#include <algorithm>
#include <cmath>

#include "eclipse/solana/programs.hpp"
#include "eclipse/swaps/constants.hpp"

namespace eclipse::swaps {

// --- Well-known program addresses -------------------------------------------

const Pubkey& pump_fun_program_id() {
  static const Pubkey id("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  return id;
}

const Pubkey& pump_fun_global() {
  static const Pubkey id("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
  return id;
}

const Pubkey& pump_fun_fee_recipient() {
  static const Pubkey id("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
  return id;
}

const Pubkey& pump_fun_event_authority() {
  static const Pubkey id("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
  return id;
}

const Pubkey& raydium_amm_program_id() {
  static const Pubkey id("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  return id;
}

const Pubkey& raydium_amm_authority() {
  // Derived rather than hardcoded: seeds ["amm authority"] over the AMM
  // program. Resolves to 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1.
  static const Pubkey id = [] {
    const std::string seed = "amm authority";
    auto derived = Pubkey::find_program_address(
        {std::vector<std::uint8_t>(seed.begin(), seed.end())},
        raydium_amm_program_id());
    return derived->first;
  }();
  return id;
}

const Pubkey& openbook_program_id() {
  static const Pubkey id("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
  return id;
}

// --- Instruction construction -----------------------------------------------

solana::Instruction build_raydium_swap(
    const Pubkey& wallet, const Pubkey& user_source_token_account,
    const Pubkey& user_destination_token_account,
    const pools::PoolAccounts& pool, std::uint64_t amount_in,
    std::uint64_t min_amount_out) {
  using solana::AccountMeta;

  solana::Instruction instruction;
  instruction.program_id = raydium_amm_program_id();

  instruction.accounts = {
      AccountMeta::readonly(solana::token_program_id()),
      AccountMeta::writable(pool.amm_id),
      AccountMeta::readonly(pool.amm_authority),
      AccountMeta::writable(pool.amm_open_orders),
      AccountMeta::writable(pool.amm_target_orders),
      AccountMeta::writable(pool.pool_coin_token_account),
      AccountMeta::writable(pool.pool_pc_token_account),
      AccountMeta::readonly(pool.serum_program_id),
      AccountMeta::writable(pool.serum_market),
      AccountMeta::writable(pool.serum_bids),
      AccountMeta::writable(pool.serum_asks),
      AccountMeta::writable(pool.serum_event_queue),
      AccountMeta::writable(pool.serum_coin_vault_account),
      AccountMeta::writable(pool.serum_pc_vault_account),
      AccountMeta::readonly(pool.serum_vault_signer),
      AccountMeta::writable(user_source_token_account),
      AccountMeta::writable(user_destination_token_account),
      AccountMeta::signer(wallet, false),
  };

  solana::put_u8(instruction.data, kRaydiumSwapBaseIn);
  solana::put_u64(instruction.data, amount_in);
  solana::put_u64(instruction.data, min_amount_out);

  return instruction;
}

std::vector<solana::Instruction> build_wrapped_sol_account(
    const Pubkey& wallet, const Pubkey& wsol_account, std::uint64_t lamports,
    std::uint64_t rent_exempt_minimum) {
  // The account has to hold the swap amount plus enough to stay rent exempt,
  // or the runtime reaps it before the swap lands.
  const std::uint64_t funding = lamports + rent_exempt_minimum;

  return {
      solana::system_program::create_account(
          wallet, wsol_account, funding, solana::kTokenAccountSize,
          solana::token_program_id()),
      solana::token_program::initialize_account(
          wsol_account, solana::native_mint(), wallet),
  };
}

std::uint64_t apply_slippage(std::uint64_t amount, double slippage_percent) {
  const double clamped = std::clamp(slippage_percent, 0.0, 100.0);
  const double factor = 1.0 - clamped / 100.0;

  const double result = std::floor(static_cast<double>(amount) * factor);
  if (result <= 0.0) return 0;
  return static_cast<std::uint64_t>(result);
}

std::uint64_t apply_slippage_ceiling(std::uint64_t amount,
                                     double slippage_percent) {
  const double clamped = std::clamp(slippage_percent, 0.0, 100.0);
  const double factor = 1.0 + clamped / 100.0;
  return static_cast<std::uint64_t>(
      std::floor(static_cast<double>(amount) * factor));
}

}  // namespace eclipse::swaps
