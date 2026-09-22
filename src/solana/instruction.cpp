#include "eclipse/solana/instruction.hpp"

#include <algorithm>
#include <cstring>

namespace eclipse::solana {

void put_u8(std::vector<std::uint8_t>& out, std::uint8_t value) {
  out.push_back(value);
}

void put_u16(std::vector<std::uint8_t>& out, std::uint16_t value) {
  out.push_back(static_cast<std::uint8_t>(value & 0xFF));
  out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
}

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) {
    out.push_back(static_cast<std::uint8_t>((value >> (8 * i)) & 0xFF));
  }
}

void put_u64(std::vector<std::uint8_t>& out, std::uint64_t value) {
  for (int i = 0; i < 8; ++i) {
    out.push_back(static_cast<std::uint8_t>((value >> (8 * i)) & 0xFF));
  }
}

void put_bytes(std::vector<std::uint8_t>& out,
               const std::vector<std::uint8_t>& value) {
  out.insert(out.end(), value.begin(), value.end());
}

std::uint16_t read_u16(const std::vector<std::uint8_t>& data,
                       std::size_t offset) {
  if (offset + 2 > data.size()) return 0;
  return static_cast<std::uint16_t>(data[offset]) |
         (static_cast<std::uint16_t>(data[offset + 1]) << 8);
}

std::uint32_t read_u32(const std::vector<std::uint8_t>& data,
                       std::size_t offset) {
  if (offset + 4 > data.size()) return 0;
  std::uint32_t value = 0;
  for (int i = 3; i >= 0; --i) {
    value = (value << 8) | data[offset + static_cast<std::size_t>(i)];
  }
  return value;
}

std::uint64_t read_u64(const std::vector<std::uint8_t>& data,
                       std::size_t offset) {
  if (offset + 8 > data.size()) return 0;
  std::uint64_t value = 0;
  for (int i = 7; i >= 0; --i) {
    value = (value << 8) | data[offset + static_cast<std::size_t>(i)];
  }
  return value;
}

Pubkey read_pubkey(const std::vector<std::uint8_t>& data, std::size_t offset) {
  Pubkey::Bytes bytes{};
  if (offset + Pubkey::kSize > data.size()) return Pubkey(bytes);
  std::copy(data.begin() + static_cast<long>(offset),
            data.begin() + static_cast<long>(offset + Pubkey::kSize),
            bytes.begin());
  return Pubkey(bytes);
}

void put_compact_u16(std::vector<std::uint8_t>& out, std::uint16_t value) {
  // Seven bits per byte, low group first; the high bit marks continuation.
  std::uint16_t remaining = value;
  while (true) {
    std::uint8_t chunk = remaining & 0x7F;
    remaining >>= 7;
    if (remaining == 0) {
      out.push_back(chunk);
      return;
    }
    out.push_back(chunk | 0x80);
  }
}

}  // namespace eclipse::solana
