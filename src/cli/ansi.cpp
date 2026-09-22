#include "eclipse/cli/ansi.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>

#if !defined(_WIN32)
#include <unistd.h>
#endif

namespace eclipse::ansi {
namespace {

bool g_enabled = detect_tty();

int hex_pair(const char* p) {
  const auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  const int hi = nibble(p[0]);
  const int lo = nibble(p[1]);
  if (hi < 0 || lo < 0) return -1;
  return hi * 16 + lo;
}

}  // namespace

bool detect_tty() {
#if defined(_WIN32)
  return true;
#else
  if (isatty(fileno(stdout)) == 0) return false;
  const char* term = std::getenv("TERM");
  return term == nullptr || std::strcmp(term, "dumb") != 0;
#endif
}

void set_enabled(bool value) { g_enabled = value; }
bool enabled() { return g_enabled; }

std::string hex(const char* hex_color) {
  if (!g_enabled || hex_color == nullptr) return {};

  const char* p = hex_color;
  if (*p == '#') ++p;
  if (std::strlen(p) < 6) return {};

  const int r = hex_pair(p);
  const int g = hex_pair(p + 2);
  const int b = hex_pair(p + 4);
  if (r < 0 || g < 0 || b < 0) return {};

  return "\033[38;2;" + std::to_string(r) + ';' + std::to_string(g) + ';' +
         std::to_string(b) + 'm';
}

std::string paint(const char* hex_color, const std::string& text) {
  if (!g_enabled) return text;
  return hex(hex_color) + text + kReset;
}

std::string paint_bold(const char* hex_color, const std::string& text) {
  if (!g_enabled) return text;
  return std::string(kBold) + hex(hex_color) + text + kReset;
}

void clear_screen() {
  if (!g_enabled) {
    std::cout << '\n';
    return;
  }
  // Cursor home, then clear to end of screen.
  std::cout << "\033[H\033[2J" << std::flush;
}

}  // namespace eclipse::ansi
