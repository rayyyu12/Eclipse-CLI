#include "eclipse/cli/validation.hpp"

#include <cctype>
#include <cstdlib>

#include "eclipse/cli/config.hpp"
#include "eclipse/common/base58.hpp"
#include "eclipse/common/pubkey.hpp"

namespace eclipse::cli {
namespace {

bool starts_with(const std::string& text, const char* prefix) {
  return text.rfind(prefix, 0) == 0;
}

/// Minimal scheme + host check. A full URL parser is not worth the dependency
/// for validating something the user typed.
bool has_host_after(const std::string& text, std::size_t scheme_length) {
  return text.size() > scheme_length &&
         text.find('.', scheme_length) != std::string::npos;
}

}  // namespace

std::optional<double> parse_double(const std::string& text) {
  if (text.empty()) return std::nullopt;

  char* end = nullptr;
  const double value = std::strtod(text.c_str(), &end);

  // Reject trailing characters: "1.5abc" should not parse as 1.5.
  if (end == text.c_str() || *end != '\0') return std::nullopt;
  return value;
}

bool validate_sol_amount(const std::string& text) {
  const auto value = parse_double(text);
  if (!value.has_value()) return false;
  return *value > config::kMinSolAmount && *value <= config::kMaxSolAmount;
}

bool validate_public_key(const std::string& text) {
  return Pubkey::try_parse(text).has_value();
}

bool validate_percentage(const std::string& text) {
  const auto value = parse_double(text);
  if (!value.has_value()) return false;
  return *value >= 0.0 && *value <= 100.0;
}

bool validate_http_url(const std::string& text) {
  if (starts_with(text, "https://")) return has_host_after(text, 8);
  if (starts_with(text, "http://")) return has_host_after(text, 7);
  return false;
}

bool validate_ws_url(const std::string& text) {
  if (starts_with(text, "wss://")) return has_host_after(text, 6);
  if (starts_with(text, "ws://")) return has_host_after(text, 5);
  return false;
}

}  // namespace eclipse::cli
