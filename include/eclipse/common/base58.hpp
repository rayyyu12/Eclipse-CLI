#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace eclipse::base58 {

/// Bitcoin/Solana alphabet. Excludes 0, O, I and l.
inline constexpr const char* kAlphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

std::string encode(const std::uint8_t* data, std::size_t len);
std::string encode(const std::vector<std::uint8_t>& data);

/// Returns nullopt when the input contains a character outside the alphabet.
std::optional<std::vector<std::uint8_t>> decode(const std::string& text);

/// True when every character is in the alphabet and the decoded length matches.
bool is_valid(const std::string& text, std::size_t expected_len);

}  // namespace eclipse::base58
