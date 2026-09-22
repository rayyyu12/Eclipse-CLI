#pragma once

#include <cstdint>
#include <vector>

#include "eclipse/common/pubkey.hpp"

namespace eclipse::solana {

struct AccountMeta {
  Pubkey pubkey;
  bool is_signer = false;
  bool is_writable = false;

  static AccountMeta signer(const Pubkey& key, bool writable = true) {
    return {key, true, writable};
  }
  static AccountMeta writable(const Pubkey& key) { return {key, false, true}; }
  static AccountMeta readonly(const Pubkey& key) { return {key, false, false}; }
};

struct Instruction {
  Pubkey program_id;
  std::vector<AccountMeta> accounts;
  std::vector<std::uint8_t> data;
};

/// Little-endian appenders for building instruction payloads.
void put_u8(std::vector<std::uint8_t>& out, std::uint8_t value);
void put_u16(std::vector<std::uint8_t>& out, std::uint16_t value);
void put_u32(std::vector<std::uint8_t>& out, std::uint32_t value);
void put_u64(std::vector<std::uint8_t>& out, std::uint64_t value);
void put_bytes(std::vector<std::uint8_t>& out,
               const std::vector<std::uint8_t>& value);

/// Little-endian readers. Return 0 when the buffer is too short.
std::uint16_t read_u16(const std::vector<std::uint8_t>& data,
                       std::size_t offset);
std::uint32_t read_u32(const std::vector<std::uint8_t>& data,
                       std::size_t offset);
std::uint64_t read_u64(const std::vector<std::uint8_t>& data,
                       std::size_t offset);
Pubkey read_pubkey(const std::vector<std::uint8_t>& data, std::size_t offset);

/// Solana's compact-u16 ("shortvec") length prefix.
void put_compact_u16(std::vector<std::uint8_t>& out, std::uint16_t value);

}  // namespace eclipse::solana
