#pragma once

#include <string>

namespace eclipse::ansi {

inline constexpr const char* kReset = "\033[0m";
inline constexpr const char* kBold = "\033[1m";
inline constexpr const char* kDim = "\033[2m";

inline constexpr const char* kRed = "\033[31m";
inline constexpr const char* kGreen = "\033[32m";
inline constexpr const char* kYellow = "\033[33m";
inline constexpr const char* kCyan = "\033[36m";
inline constexpr const char* kWhite = "\033[37m";

/// 24-bit foreground escape for a "#rrggbb" literal, the equivalent of
/// chalk.hex in the TypeScript build.
std::string hex(const char* hex_color);

/// Wraps text in a 24-bit foreground colour and resets afterwards.
std::string paint(const char* hex_color, const std::string& text);

/// Same, plus bold.
std::string paint_bold(const char* hex_color, const std::string& text);

/// Disables every escape sequence, for pipes and dumb terminals.
void set_enabled(bool enabled);
bool enabled();

/// True when stdout is a TTY and TERM is not "dumb".
bool detect_tty();

void clear_screen();

}  // namespace eclipse::ansi
