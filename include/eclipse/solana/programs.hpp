#pragma once

#include <cstdint>
#include <string>

#include "eclipse/common/pubkey.hpp"
#include "eclipse/solana/instruction.hpp"

namespace eclipse::solana {

inline constexpr std::uint64_t kLamportsPerSol = 1000000000ULL;

/// Size of an SPL token account, needed when renting a temporary WSOL account.
inline constexpr std::size_t kTokenAccountSize = 165;

const Pubkey& system_program_id();
const Pubkey& token_program_id();
const Pubkey& associated_token_program_id();
const Pubkey& compute_budget_program_id();
const Pubkey& rent_sysvar_id();
const Pubkey& native_mint();  ///< wrapped SOL

namespace system_program {

Instruction transfer(const Pubkey& from, const Pubkey& to,
                     std::uint64_t lamports);

Instruction create_account(const Pubkey& from, const Pubkey& new_account,
                           std::uint64_t lamports, std::uint64_t space,
                           const Pubkey& owner);

}  // namespace system_program

namespace token_program {

Instruction initialize_account(const Pubkey& account, const Pubkey& mint,
                               const Pubkey& owner);

Instruction close_account(const Pubkey& account, const Pubkey& destination,
                          const Pubkey& owner);

Instruction sync_native(const Pubkey& account);

Instruction transfer(const Pubkey& source, const Pubkey& destination,
                     const Pubkey& owner, std::uint64_t amount);

}  // namespace token_program

namespace associated_token {

/// Idempotent create: succeeds even when the account already exists, which
/// avoids a separate existence probe before every swap.
Instruction create_idempotent(const Pubkey& payer, const Pubkey& owner,
                              const Pubkey& mint);

/// Same, for a caller that has already derived the account address and does
/// not want to pay for the program-address search twice.
Instruction create_idempotent(const Pubkey& payer, const Pubkey& ata,
                              const Pubkey& owner, const Pubkey& mint);

}  // namespace associated_token

namespace compute_budget {

Instruction set_compute_unit_limit(std::uint32_t units);
Instruction set_compute_unit_price(std::uint64_t micro_lamports);

}  // namespace compute_budget

}  // namespace eclipse::solana
