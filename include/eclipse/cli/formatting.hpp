#pragma once

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace eclipse::cli {

/// Reads a line from stdin. Returns false at EOF, which is how a piped
/// session ends.
bool prompt(const std::string& question, std::string& answer);

/// Re-asks until the validator accepts. Returns false at EOF.
bool prompt_validated(const std::string& question,
                      const std::function<bool(const std::string&)>& validator,
                      const std::string& error_message, std::string& answer);

/// Reads a secret without echoing it. Falls back to a normal read when stdin
/// is not a terminal.
bool prompt_hidden(const std::string& question, std::string& answer);

void press_enter_to_continue();

void display_error(const std::string& message, const std::string& detail = {});
void display_success(const std::string& message,
                     const std::string& detail = {});
void display_info(const std::string& message);
void display_warning(const std::string& message);

/// Formats a SOL amount to 4 decimal places with its unit.
std::string format_sol(double amount);

/// Signed percentage with two decimals.
std::string format_percent(double value);

/// Shortens a base58 address to "abcd...wxyz".
std::string shorten(const std::string& address, std::size_t edge = 4);

/// A single-line braille spinner on its own thread.
///
/// Prints nothing when stdout is not a terminal, so piped output stays clean.
class Spinner {
 public:
  explicit Spinner(std::string message);
  ~Spinner();

  void update(const std::string& message);
  void succeed(const std::string& message);
  void fail(const std::string& message);
  void stop();

  Spinner(const Spinner&) = delete;
  Spinner& operator=(const Spinner&) = delete;

 private:
  void clear_line();

  std::atomic<bool> running_{false};
  std::thread thread_;
  std::mutex message_mutex_;
  std::string message_;
};

}  // namespace eclipse::cli
