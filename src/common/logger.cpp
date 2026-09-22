#include "eclipse/common/logger.hpp"

#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <system_error>

#include "eclipse/cli/ansi.hpp"

namespace eclipse {
namespace {

constexpr std::size_t kMaxHistory = 1000;
constexpr std::uintmax_t kMaxLogBytes = 5 * 1024 * 1024;

std::string format_time(std::chrono::system_clock::time_point tp, bool iso) {
  const std::time_t t = std::chrono::system_clock::to_time_t(tp);
  std::tm tm{};
#if defined(_WIN32)
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  std::ostringstream out;
  out << std::put_time(&tm, iso ? "%Y-%m-%dT%H:%M:%S" : "%H:%M:%S");
  return out.str();
}

const char* level_color(LogLevel level) {
  switch (level) {
    case LogLevel::Debug:   return ansi::kDim;
    case LogLevel::Info:    return ansi::kCyan;
    case LogLevel::Success: return ansi::kGreen;
    case LogLevel::Warn:    return ansi::kYellow;
    case LogLevel::Error:   return ansi::kRed;
    default:                return ansi::kReset;
  }
}

}  // namespace

const char* to_string(LogLevel level) {
  switch (level) {
    case LogLevel::Debug:   return "DEBUG";
    case LogLevel::Info:    return "INFO";
    case LogLevel::Success: return "SUCCESS";
    case LogLevel::Warn:    return "WARN";
    case LogLevel::Error:   return "ERROR";
    case LogLevel::None:    return "NONE";
  }
  return "UNKNOWN";
}

Logger& Logger::instance() {
  static Logger logger;
  return logger;
}

void Logger::initialize(const Options& options) {
  std::lock_guard<std::mutex> lock(mutex_);
  options_ = options;

  if (options_.log_dir.empty()) options_.log_dir = "logs";

  if (options_.log_to_file) {
    std::error_code ec;
    std::filesystem::create_directories(options_.log_dir, ec);
    if (ec) {
      // A read-only working directory should not stop the CLI from running.
      options_.log_to_file = false;
    } else {
      log_file_ = options_.log_dir /
                  ("eclipse-" + format_time(std::chrono::system_clock::now(),
                                            true)
                                    .substr(0, 10) +
                   ".log");
      file_.open(log_file_, std::ios::app);
      if (!file_.is_open()) options_.log_to_file = false;
    }
  }

  initialized_ = true;
}

void Logger::set_log_level(LogLevel level) {
  std::lock_guard<std::mutex> lock(mutex_);
  options_.log_level = level;
}

void Logger::set_file_logging(bool enabled) {
  std::lock_guard<std::mutex> lock(mutex_);
  options_.log_to_file = enabled && !log_file_.empty();
}

void Logger::set_console_logging(bool enabled) {
  std::lock_guard<std::mutex> lock(mutex_);
  options_.log_to_console = enabled;
}

void Logger::write(LogLevel level, const std::string& module,
                   const std::string& message, const std::string& data) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!initialized_) {
    options_.log_dir = "logs";
    initialized_ = true;
  }
  if (level < options_.log_level) return;

  LogEntry entry{std::chrono::system_clock::now(), level, module, message,
                 data};

  history_.push_back(entry);
  if (history_.size() > kMaxHistory) history_.pop_front();

  if (options_.log_to_console) write_to_console(entry);
  if (options_.log_to_file) write_to_file(entry);
}

void Logger::write_to_console(const LogEntry& entry) {
  std::ostream& out =
      entry.level >= LogLevel::Warn ? std::cerr : std::cout;

  out << ansi::kDim << format_time(entry.timestamp, false) << ansi::kReset
      << ' ' << level_color(entry.level) << std::setw(7) << std::left
      << to_string(entry.level) << ansi::kReset;

  if (!entry.module.empty()) {
    out << ' ' << ansi::kDim << '[' << entry.module << ']' << ansi::kReset;
  }
  out << ' ' << entry.message << '\n';

  if (!entry.data.empty()) {
    out << ansi::kDim << "  " << entry.data << ansi::kReset << '\n';
  }
}

void Logger::write_to_file(const LogEntry& entry) {
  rotate_if_needed();
  if (!file_.is_open()) return;

  file_ << format_time(entry.timestamp, true) << ' ' << to_string(entry.level)
        << ' ';
  if (!entry.module.empty()) file_ << '[' << entry.module << "] ";
  file_ << entry.message << '\n';

  if (!entry.data.empty()) file_ << entry.data << '\n';
  file_.flush();
}

void Logger::rotate_if_needed() {
  if (log_file_.empty()) return;

  std::error_code ec;
  const auto size = std::filesystem::file_size(log_file_, ec);
  if (ec || size < kMaxLogBytes) return;

  file_.close();
  const auto stamp = format_time(std::chrono::system_clock::now(), true);
  auto rotated = log_file_;
  rotated.replace_extension("." + stamp + ".log");
  std::filesystem::rename(log_file_, rotated, ec);
  file_.open(log_file_, std::ios::app);
}

void Logger::debug(const std::string& m, const std::string& s,
                   const std::string& d) {
  write(LogLevel::Debug, m, s, d);
}
void Logger::info(const std::string& m, const std::string& s,
                  const std::string& d) {
  write(LogLevel::Info, m, s, d);
}
void Logger::success(const std::string& m, const std::string& s,
                     const std::string& d) {
  write(LogLevel::Success, m, s, d);
}
void Logger::warn(const std::string& m, const std::string& s,
                  const std::string& d) {
  write(LogLevel::Warn, m, s, d);
}
void Logger::error(const std::string& m, const std::string& s,
                   const std::string& d) {
  write(LogLevel::Error, m, s, d);
}

std::deque<LogEntry> Logger::recent(std::size_t count) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (count == 0 || count >= history_.size()) return history_;
  return std::deque<LogEntry>(history_.end() - static_cast<long>(count),
                              history_.end());
}

void Logger::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  history_.clear();
}

}  // namespace eclipse
