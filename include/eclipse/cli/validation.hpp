#pragma once

#include <optional>
#include <string>

namespace eclipse::cli {

/// Accepts a positive decimal inside the configured SOL bounds.
bool validate_sol_amount(const std::string& text);

/// Accepts a base58 string that decodes to exactly 32 bytes.
bool validate_public_key(const std::string& text);

/// Accepts 0 to 100 inclusive.
bool validate_percentage(const std::string& text);

/// Accepts http:// or https:// with a host.
bool validate_http_url(const std::string& text);

/// Accepts ws:// or wss:// with a host.
bool validate_ws_url(const std::string& text);

/// Parses a decimal, returning nullopt rather than throwing on bad input.
/// std::stod would throw and accepts trailing garbage.
std::optional<double> parse_double(const std::string& text);

}  // namespace eclipse::cli
