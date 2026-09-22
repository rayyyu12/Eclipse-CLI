#pragma once

#include <chrono>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>

namespace eclipse {

enum class LogLevel { Debug = 0, Info = 1, Success = 2, Warn = 3, Error = 4, None = 5 };

const char* to_string(LogLevel level);

struct LogEntry {
  std::chrono::system_clock::time_point timestamp;
  LogLevel level;
  std::string module;
  std::string message;
  std::string data;
};

/// Process-wide logger. Console output is colourised; file output is plain and
/// rotates at 5 MiB. Safe to call from any thread.
class Logger {
 public:
  struct Options {
    LogLevel log_level = LogLevel::Info;
    bool log_to_file = true;
    bool log_to_console = true;
    std::filesystem::path log_dir;  ///< defaults to ./logs
  };

  static Logger& instance();

  void initialize(const Options& options);

  void set_log_level(LogLevel level);
  void set_file_logging(bool enabled);
  void set_console_logging(bool enabled);

  void debug(const std::string& module, const std::string& message,
             const std::string& data = {});
  void info(const std::string& module, const std::string& message,
            const std::string& data = {});
  void success(const std::string& module, const std::string& message,
               const std::string& data = {});
  void warn(const std::string& module, const std::string& message,
            const std::string& data = {});
  void error(const std::string& module, const std::string& message,
             const std::string& data = {});

  /// Most recent entries, newest last. Capped at 1000.
  std::deque<LogEntry> recent(std::size_t count) const;
  void clear();

 private:
  Logger() = default;

  void write(LogLevel level, const std::string& module,
             const std::string& message, const std::string& data);
  void write_to_console(const LogEntry& entry);
  void write_to_file(const LogEntry& entry);
  void rotate_if_needed();

  mutable std::mutex mutex_;
  Options options_;
  bool initialized_ = false;
  std::ofstream file_;
  std::filesystem::path log_file_;
  std::deque<LogEntry> history_;
};

}  // namespace eclipse
