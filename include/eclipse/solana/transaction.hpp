#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "eclipse/common/keypair.hpp"
#include "eclipse/common/pubkey.hpp"
#include "eclipse/solana/instruction.hpp"

namespace eclipse::solana {

/// A compiled legacy message: deduplicated account list, the privilege header
/// and instructions rewritten to reference accounts by index.
struct Message {
  std::uint8_t num_required_signatures = 0;
  std::uint8_t num_readonly_signed = 0;
  std::uint8_t num_readonly_unsigned = 0;
  std::vector<Pubkey> account_keys;
  std::string recent_blockhash;  ///< base58
  struct CompiledInstruction {
    std::uint8_t program_id_index = 0;
    std::vector<std::uint8_t> account_indices;
    std::vector<std::uint8_t> data;
  };
  std::vector<CompiledInstruction> instructions;

  std::vector<std::uint8_t> serialize() const;
};

/// Builds, signs and serialises a legacy transaction.
///
/// Account ordering follows the runtime's rules: writable signers, readonly
/// signers, writable non-signers, readonly non-signers. The fee payer is
/// always index 0.
class Transaction {
 public:
  void add(const Instruction& instruction);
  void add(std::vector<Instruction> instructions);

  void set_fee_payer(const Pubkey& payer) { fee_payer_ = payer; }
  void set_recent_blockhash(const std::string& blockhash) {
    recent_blockhash_ = blockhash;
  }

  const std::vector<Instruction>& instructions() const { return instructions_; }

  Message compile() const;

  /// Signs with the given keys and returns the wire format the RPC expects.
  /// Throws when the blockhash or fee payer is unset.
  std::vector<std::uint8_t> sign_and_serialize(
      const std::vector<const Keypair*>& signers) const;

  /// Serialises with zeroed signatures, for fee estimation and simulation.
  std::vector<std::uint8_t> serialize_unsigned() const;

  /// The first signature in base58, which is the transaction id.
  static std::string signature_to_string(
      const std::vector<std::uint8_t>& wire_transaction);

 private:
  std::vector<Instruction> instructions_;
  Pubkey fee_payer_;
  std::string recent_blockhash_;
};

}  // namespace eclipse::solana
