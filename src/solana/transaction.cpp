#include "eclipse/solana/transaction.hpp"

#include <algorithm>
#include <map>
#include <stdexcept>

#include "eclipse/common/base58.hpp"

namespace eclipse::solana {
namespace {

/// Accumulated privileges for one account across every instruction.
struct Privilege {
  bool is_signer = false;
  bool is_writable = false;
};

}  // namespace

void Transaction::add(const Instruction& instruction) {
  instructions_.push_back(instruction);
}

void Transaction::add(std::vector<Instruction> instructions) {
  instructions_.insert(instructions_.end(),
                       std::make_move_iterator(instructions.begin()),
                       std::make_move_iterator(instructions.end()));
}

Message Transaction::compile() const {
  if (fee_payer_.is_default()) {
    throw std::runtime_error("transaction has no fee payer");
  }

  // An account's privileges are the union of every mention of it: writable
  // anywhere means writable, signer anywhere means signer.
  std::map<Pubkey, Privilege> privileges;

  for (const auto& instruction : instructions_) {
    for (const auto& meta : instruction.accounts) {
      auto& privilege = privileges[meta.pubkey];
      privilege.is_signer |= meta.is_signer;
      privilege.is_writable |= meta.is_writable;
    }
    // A program id is always a readonly, non-signer account.
    privileges.emplace(instruction.program_id, Privilege{});
  }

  // The fee payer signs and pays, so it is writable regardless of how the
  // instructions listed it, and it must land at index 0.
  privileges[fee_payer_] = Privilege{true, true};

  std::vector<Pubkey> writable_signers, readonly_signers;
  std::vector<Pubkey> writable_others, readonly_others;

  for (const auto& [key, privilege] : privileges) {
    if (key == fee_payer_) continue;
    if (privilege.is_signer) {
      (privilege.is_writable ? writable_signers : readonly_signers)
          .push_back(key);
    } else {
      (privilege.is_writable ? writable_others : readonly_others).push_back(key);
    }
  }

  Message message;
  message.recent_blockhash = recent_blockhash_;

  message.account_keys.push_back(fee_payer_);
  const auto append = [&message](const std::vector<Pubkey>& keys) {
    message.account_keys.insert(message.account_keys.end(), keys.begin(),
                                keys.end());
  };
  append(writable_signers);
  append(readonly_signers);
  append(writable_others);
  append(readonly_others);

  message.num_required_signatures =
      static_cast<std::uint8_t>(1 + writable_signers.size() +
                                readonly_signers.size());
  message.num_readonly_signed =
      static_cast<std::uint8_t>(readonly_signers.size());
  message.num_readonly_unsigned =
      static_cast<std::uint8_t>(readonly_others.size());

  // Index lookup for rewriting the instructions.
  std::map<Pubkey, std::uint8_t> index_of;
  for (std::size_t i = 0; i < message.account_keys.size(); ++i) {
    index_of[message.account_keys[i]] = static_cast<std::uint8_t>(i);
  }

  for (const auto& instruction : instructions_) {
    Message::CompiledInstruction compiled;
    compiled.program_id_index = index_of.at(instruction.program_id);
    compiled.data = instruction.data;

    compiled.account_indices.reserve(instruction.accounts.size());
    for (const auto& meta : instruction.accounts) {
      compiled.account_indices.push_back(index_of.at(meta.pubkey));
    }
    message.instructions.push_back(std::move(compiled));
  }

  return message;
}

std::vector<std::uint8_t> Message::serialize() const {
  std::vector<std::uint8_t> out;
  out.reserve(256 + account_keys.size() * Pubkey::kSize);

  put_u8(out, num_required_signatures);
  put_u8(out, num_readonly_signed);
  put_u8(out, num_readonly_unsigned);

  put_compact_u16(out, static_cast<std::uint16_t>(account_keys.size()));
  for (const auto& key : account_keys) {
    out.insert(out.end(), key.bytes().begin(), key.bytes().end());
  }

  auto blockhash_bytes = base58::decode(recent_blockhash);
  if (!blockhash_bytes.has_value() ||
      blockhash_bytes->size() != Pubkey::kSize) {
    throw std::runtime_error("invalid recent blockhash: " + recent_blockhash);
  }
  out.insert(out.end(), blockhash_bytes->begin(), blockhash_bytes->end());

  put_compact_u16(out, static_cast<std::uint16_t>(instructions.size()));
  for (const auto& instruction : instructions) {
    put_u8(out, instruction.program_id_index);

    put_compact_u16(
        out, static_cast<std::uint16_t>(instruction.account_indices.size()));
    out.insert(out.end(), instruction.account_indices.begin(),
               instruction.account_indices.end());

    put_compact_u16(out, static_cast<std::uint16_t>(instruction.data.size()));
    out.insert(out.end(), instruction.data.begin(), instruction.data.end());
  }

  return out;
}

std::vector<std::uint8_t> Transaction::sign_and_serialize(
    const std::vector<const Keypair*>& signers) const {
  if (recent_blockhash_.empty()) {
    throw std::runtime_error("transaction has no recent blockhash");
  }

  const Message message = compile();
  const std::vector<std::uint8_t> message_bytes = message.serialize();

  std::vector<std::uint8_t> out;
  put_compact_u16(out,
                  static_cast<std::uint16_t>(message.num_required_signatures));

  // Signatures go in account order, so each required signer is matched to its
  // slot rather than to its position in the signers argument.
  for (std::uint8_t i = 0; i < message.num_required_signatures; ++i) {
    const Pubkey& expected = message.account_keys[i];

    const auto found = std::find_if(
        signers.begin(), signers.end(), [&expected](const Keypair* keypair) {
          return keypair != nullptr && keypair->pubkey() == expected;
        });

    if (found == signers.end()) {
      throw std::runtime_error("missing signer for " + expected.to_base58());
    }

    const auto signature = (*found)->sign(message_bytes);
    out.insert(out.end(), signature.begin(), signature.end());
  }

  out.insert(out.end(), message_bytes.begin(), message_bytes.end());
  return out;
}

std::vector<std::uint8_t> Transaction::serialize_unsigned() const {
  const Message message = compile();
  const std::vector<std::uint8_t> message_bytes = message.serialize();

  std::vector<std::uint8_t> out;
  put_compact_u16(out,
                  static_cast<std::uint16_t>(message.num_required_signatures));
  out.insert(out.end(),
             static_cast<std::size_t>(message.num_required_signatures) *
                 Keypair::kSignatureSize,
             0);
  out.insert(out.end(), message_bytes.begin(), message_bytes.end());
  return out;
}

std::string Transaction::signature_to_string(
    const std::vector<std::uint8_t>& wire_transaction) {
  // One byte of shortvec count, then the first 64-byte signature.
  if (wire_transaction.size() < 1 + Keypair::kSignatureSize) return {};
  return base58::encode(wire_transaction.data() + 1, Keypair::kSignatureSize);
}

}  // namespace eclipse::solana
