#include "eclipse/cli/formatting.hpp"

#include <array>
#include <chrono>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>

#if !defined(_WIN32)
#include <termios.h>
#include <unistd.h>
#endif

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"

namespace eclipse::cli {
namespace {

using config::colors::kAccent;
using config::colors::kError;
using config::colors::kPrimary;
using config::colors::kSecondary;
using config::colors::kSuccess;

constexpr std::array<const char*, 10> kSpinnerFrames = {
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"};

}  // namespace

bool prompt(const std::string& question, std::string& answer) {
  std::cout << ansi::paint(kPrimary, question) << std::flush;
  if (!std::getline(std::cin, answer)) return false;
  return true;
}

bool prompt_validated(const std::string& question,
                      const std::function<bool(const std::string&)>& validator,
                      const std::string& error_message, std::string& answer) {
  while (true) {
    if (!prompt(question, answer)) return false;
    if (validator(answer)) return true;
    std::cout << ansi::paint(kError, error_message) << '\n';
  }
}

bool prompt_hidden(const std::string& question, std::string& answer) {
#if defined(_WIN32)
  return prompt(question, answer);
#else
  if (isatty(fileno(stdin)) == 0) return prompt(question, answer);

  std::cout << ansi::paint(kPrimary, question) << std::flush;

  termios original{};
  if (tcgetattr(fileno(stdin), &original) != 0) {
    return prompt(question, answer);
  }

  termios hidden = original;
  hidden.c_lflag &= ~static_cast<tcflag_t>(ECHO);
  tcsetattr(fileno(stdin), TCSAFLUSH, &hidden);

  const bool ok = static_cast<bool>(std::getline(std::cin, answer));

  tcsetattr(fileno(stdin), TCSAFLUSH, &original);
  std::cout << '\n';
  return ok;
#endif
}

void press_enter_to_continue() {
  std::cout << ansi::paint(kSecondary, "\nPress Enter to continue...")
            << std::flush;
  std::string discard;
  std::getline(std::cin, discard);
}

void display_error(const std::string& message, const std::string& detail) {
  std::cout << ansi::paint(kError, "✖ " + message) << '\n';
  if (!detail.empty()) {
    std::cout << ansi::paint(kError, "  " + detail) << '\n';
  }
}

void display_success(const std::string& message, const std::string& detail) {
  std::cout << ansi::paint(kSuccess, "✔ " + message) << '\n';
  if (!detail.empty()) {
    std::cout << ansi::paint(kSuccess, "  " + detail) << '\n';
  }
}

void display_info(const std::string& message) {
  std::cout << ansi::paint(kPrimary, "• " + message) << '\n';
}

void display_warning(const std::string& message) {
  std::cout << ansi::paint(kError, "! " + message) << '\n';
}

std::string format_sol(double amount) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(4) << amount << " SOL";
  return out.str();
}

std::string format_percent(double value) {
  std::ostringstream out;
  out << (value >= 0.0 ? "+" : "") << std::fixed << std::setprecision(2)
      << value << "%";
  return out.str();
}

std::string shorten(const std::string& address, std::size_t edge) {
  if (address.size() <= edge * 2 + 3) return address;
  return address.substr(0, edge) + "..." +
         address.substr(address.size() - edge);
}

Spinner::Spinner(std::string message) : message_(std::move(message)) {
  if (!ansi::enabled()) {
    std::cout << ansi::paint(kPrimary, message_) << '\n';
    return;
  }

  running_.store(true);
  thread_ = std::thread([this] {
    std::size_t frame = 0;
    while (running_.load()) {
      std::string current;
      {
        std::lock_guard<std::mutex> lock(message_mutex_);
        current = message_;
      }

      std::cout << "\r\033[K"
                << ansi::paint(kAccent, kSpinnerFrames[frame]) << ' '
                << ansi::paint(kPrimary, current) << std::flush;

      frame = (frame + 1) % kSpinnerFrames.size();
      std::this_thread::sleep_for(std::chrono::milliseconds(80));
    }
  });
}

void Spinner::update(const std::string& message) {
  std::lock_guard<std::mutex> lock(message_mutex_);
  message_ = message;
}

void Spinner::clear_line() {
  if (ansi::enabled()) std::cout << "\r\033[K" << std::flush;
}

void Spinner::stop() {
  if (!running_.exchange(false)) return;
  if (thread_.joinable()) thread_.join();
  clear_line();
}

void Spinner::succeed(const std::string& message) {
  stop();
  display_success(message);
}

void Spinner::fail(const std::string& message) {
  stop();
  display_error(message);
}

Spinner::~Spinner() { stop(); }

}  // namespace eclipse::cli
