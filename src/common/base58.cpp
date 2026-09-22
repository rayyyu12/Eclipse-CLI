#include "eclipse/common/base58.hpp"

#include <algorithm>
#include <array>

namespace eclipse::base58 {
namespace {

/// Reverse lookup for kAlphabet; 0xFF marks a character outside the alphabet.
const std::array<std::uint8_t, 256>& decode_table() {
  static const std::array<std::uint8_t, 256> table = [] {
    std::array<std::uint8_t, 256> t{};
    t.fill(0xFF);
    for (std::uint8_t i = 0; kAlphabet[i] != '\0'; ++i) {
      t[static_cast<std::uint8_t>(kAlphabet[i])] = i;
    }
    return t;
  }();
  return table;
}

}  // namespace

std::string encode(const std::uint8_t* data, std::size_t len) {
  if (len == 0) return {};

  // Leading zero bytes map to '1' one-for-one and are not part of the
  // big-integer conversion.
  std::size_t leading_zeros = 0;
  while (leading_zeros < len && data[leading_zeros] == 0) ++leading_zeros;

  // log(256)/log(58) rounded up, so the buffer always fits.
  std::vector<std::uint8_t> digits((len - leading_zeros) * 138 / 100 + 1, 0);
  std::size_t digit_count = 0;

  for (std::size_t i = leading_zeros; i < len; ++i) {
    int carry = data[i];
    std::size_t written = 0;
    for (auto it = digits.rbegin(); it != digits.rend() &&
                                    (carry != 0 || written < digit_count);
         ++it, ++written) {
      carry += 256 * (*it);
      *it = static_cast<std::uint8_t>(carry % 58);
      carry /= 58;
    }
    digit_count = written;
  }

  std::string out;
  out.reserve(leading_zeros + digit_count);
  out.assign(leading_zeros, '1');
  for (auto it = digits.end() - static_cast<long>(digit_count);
       it != digits.end(); ++it) {
    out.push_back(kAlphabet[*it]);
  }
  return out;
}

std::string encode(const std::vector<std::uint8_t>& data) {
  return encode(data.data(), data.size());
}

std::optional<std::vector<std::uint8_t>> decode(const std::string& text) {
  if (text.empty()) return std::vector<std::uint8_t>{};

  const auto& table = decode_table();

  std::size_t leading_ones = 0;
  while (leading_ones < text.size() && text[leading_ones] == '1') ++leading_ones;

  // log(58)/log(256) rounded up.
  std::vector<std::uint8_t> bytes((text.size() - leading_ones) * 733 / 1000 + 1,
                                  0);
  std::size_t byte_count = 0;

  for (std::size_t i = leading_ones; i < text.size(); ++i) {
    const std::uint8_t value = table[static_cast<std::uint8_t>(text[i])];
    if (value == 0xFF) return std::nullopt;

    int carry = value;
    std::size_t written = 0;
    for (auto it = bytes.rbegin(); it != bytes.rend() &&
                                   (carry != 0 || written < byte_count);
         ++it, ++written) {
      carry += 58 * (*it);
      *it = static_cast<std::uint8_t>(carry % 256);
      carry /= 256;
    }
    byte_count = written;
  }

  std::vector<std::uint8_t> out;
  out.reserve(leading_ones + byte_count);
  out.assign(leading_ones, 0);
  out.insert(out.end(), bytes.end() - static_cast<long>(byte_count),
             bytes.end());
  return out;
}

bool is_valid(const std::string& text, std::size_t expected_len) {
  const auto decoded = decode(text);
  return decoded.has_value() && decoded->size() == expected_len;
}

}  // namespace eclipse::base58
