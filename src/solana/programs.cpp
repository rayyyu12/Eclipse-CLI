#include "eclipse/solana/programs.hpp"

namespace eclipse::solana {

const Pubkey& system_program_id() {
  static const Pubkey id("11111111111111111111111111111111");
  return id;
}

const Pubkey& token_program_id() {
  static const Pubkey id("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  return id;
}

const Pubkey& associated_token_program_id() {
  static const Pubkey id("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  return id;
}

const Pubkey& compute_budget_program_id() {
  static const Pubkey id("ComputeBudget111111111111111111111111111111");
  return id;
}

const Pubkey& rent_sysvar_id() {
  static const Pubkey id("SysvarRent111111111111111111111111111111111");
  return id;
}

const Pubkey& native_mint() {
  static const Pubkey id("So11111111111111111111111111111111111111112");
  return id;
}

namespace system_program {

Instruction transfer(const Pubkey& from, const Pubkey& to,
                     std::uint64_t lamports) {
  Instruction instruction;
  instruction.program_id = system_program_id();
  instruction.accounts = {AccountMeta::signer(from), AccountMeta::writable(to)};

  put_u32(instruction.data, 2);  // Transfer
  put_u64(instruction.data, lamports);
  return instruction;
}

Instruction create_account(const Pubkey& from, const Pubkey& new_account,
                           std::uint64_t lamports, std::uint64_t space,
                           const Pubkey& owner) {
  Instruction instruction;
  instruction.program_id = system_program_id();
  instruction.accounts = {AccountMeta::signer(from),
                          AccountMeta::signer(new_account)};

  put_u32(instruction.data, 0);  // CreateAccount
  put_u64(instruction.data, lamports);
  put_u64(instruction.data, space);
  put_bytes(instruction.data,
            std::vector<std::uint8_t>(owner.bytes().begin(),
                                      owner.bytes().end()));
  return instruction;
}

}  // namespace system_program

namespace token_program {

Instruction initialize_account(const Pubkey& account, const Pubkey& mint,
                               const Pubkey& owner) {
  Instruction instruction;
  instruction.program_id = token_program_id();
  instruction.accounts = {
      AccountMeta::writable(account), AccountMeta::readonly(mint),
      AccountMeta::readonly(owner), AccountMeta::readonly(rent_sysvar_id())};

  put_u8(instruction.data, 1);  // InitializeAccount
  return instruction;
}

Instruction close_account(const Pubkey& account, const Pubkey& destination,
                          const Pubkey& owner) {
  Instruction instruction;
  instruction.program_id = token_program_id();
  instruction.accounts = {AccountMeta::writable(account),
                          AccountMeta::writable(destination),
                          AccountMeta::signer(owner, false)};

  put_u8(instruction.data, 9);  // CloseAccount
  return instruction;
}

Instruction sync_native(const Pubkey& account) {
  Instruction instruction;
  instruction.program_id = token_program_id();
  instruction.accounts = {AccountMeta::writable(account)};

  put_u8(instruction.data, 17);  // SyncNative
  return instruction;
}

Instruction transfer(const Pubkey& source, const Pubkey& destination,
                     const Pubkey& owner, std::uint64_t amount) {
  Instruction instruction;
  instruction.program_id = token_program_id();
  instruction.accounts = {AccountMeta::writable(source),
                          AccountMeta::writable(destination),
                          AccountMeta::signer(owner, false)};

  put_u8(instruction.data, 3);  // Transfer
  put_u64(instruction.data, amount);
  return instruction;
}

}  // namespace token_program

namespace associated_token {

Instruction create_idempotent(const Pubkey& payer, const Pubkey& owner,
                              const Pubkey& mint) {
  return create_idempotent(payer, Pubkey::associated_token_address(owner, mint),
                           owner, mint);
}

Instruction create_idempotent(const Pubkey& payer, const Pubkey& ata,
                              const Pubkey& owner, const Pubkey& mint) {
  Instruction instruction;
  instruction.program_id = associated_token_program_id();
  instruction.accounts = {AccountMeta::signer(payer),
                          AccountMeta::writable(ata),
                          AccountMeta::readonly(owner),
                          AccountMeta::readonly(mint),
                          AccountMeta::readonly(system_program_id()),
                          AccountMeta::readonly(token_program_id())};

  put_u8(instruction.data, 1);  // CreateIdempotent
  return instruction;
}

}  // namespace associated_token

namespace compute_budget {

Instruction set_compute_unit_limit(std::uint32_t units) {
  Instruction instruction;
  instruction.program_id = compute_budget_program_id();
  put_u8(instruction.data, 2);  // SetComputeUnitLimit
  put_u32(instruction.data, units);
  return instruction;
}

Instruction set_compute_unit_price(std::uint64_t micro_lamports) {
  Instruction instruction;
  instruction.program_id = compute_budget_program_id();
  put_u8(instruction.data, 3);  // SetComputeUnitPrice
  put_u64(instruction.data, micro_lamports);
  return instruction;
}

}  // namespace compute_budget

}  // namespace eclipse::solana
