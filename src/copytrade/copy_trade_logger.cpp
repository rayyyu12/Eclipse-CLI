#include "eclipse/copytrade/copy_trade_logger.hpp"

#include <cctype>
#include <ctime>
#include <iomanip>
#include <sstream>

#include "eclipse/cli/ansi.hpp"
#include "eclipse/cli/config.hpp"
#include "eclipse/common/logger.hpp"

namespace eclipse::copytrade {
namespace {

using namespace config::colors;

std::string format_timestamp(std::chrono::system_clock::time_point tp) {
  const std::time_t t = std::chrono::system_clock::to_time_t(tp);
  std::tm tm{};
#if defined(_WIN32)
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  std::ostringstream out;
  out << std::put_time(&tm, "%Y-%m-%d %H:%M:%S");
  return out.str();
}

std::string join_details(const CopyTradeLogger::Details& details) {
  std::string out;
  for (const auto& [key, value] : details) {
    if (!out.empty()) out += ", ";
    out += key + "=" + value;
  }
  return out;
}

}  // namespace

const char* to_string(CopyLogType type) {
  switch (type) {
    case CopyLogType::Info:    return "info";
    case CopyLogType::Success: return "success";
    case CopyLogType::Error:   return "error";
  }
  return "info";
}

CopyTradeLogger& CopyTradeLogger::instance() {
  static CopyTradeLogger logger;
  return logger;
}

void CopyTradeLogger::add(CopyLogType type, const std::string& protocol,
                          const std::string& message, Details details) {
  CopyTradeLog entry{std::chrono::system_clock::now(), type, protocol, message,
                     std::move(details)};

  // Mirrored into the main log so a session can be reconstructed afterwards.
  auto& system_logger = Logger::instance();
  const std::string module = "CopyTrade";
  const std::string line = protocol + ": " + message;
  const std::string data = join_details(entry.details);
  switch (type) {
    case CopyLogType::Info:    system_logger.info(module, line, data); break;
    case CopyLogType::Success: system_logger.success(module, line, data); break;
    case CopyLogType::Error:   system_logger.error(module, line, data); break;
  }

  std::vector<Listener> listeners;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    logs_.push_back(entry);
    if (logs_.size() > kMaxLogs) logs_.pop_front();

    listeners.reserve(listeners_.size());
    for (const auto& [id, listener] : listeners_) listeners.push_back(listener);
  }

  // Outside the lock: a listener prints, and must be free to read the log.
  for (const auto& listener : listeners) listener(entry);
}

std::vector<CopyTradeLog> CopyTradeLogger::get(std::size_t count) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::size_t start =
      count == 0 || count >= logs_.size() ? 0 : logs_.size() - count;
  return std::vector<CopyTradeLog>(logs_.begin() + static_cast<long>(start),
                                   logs_.end());
}

void CopyTradeLogger::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  logs_.clear();
}

std::string CopyTradeLogger::format(const CopyTradeLog& log) {
  const char* color = kAccent;
  switch (log.type) {
    case CopyLogType::Success: color = kSuccess; break;
    case CopyLogType::Error:   color = kError; break;
    case CopyLogType::Info:    color = kAccent; break;
  }

  std::string type = to_string(log.type);
  for (auto& c : type) c = static_cast<char>(std::toupper(c));

  return ansi::paint(kSecondary, format_timestamp(log.timestamp)) + " [" +
         ansi::paint(color, type) + "] " + ansi::paint(kPrimary, log.protocol) +
         ": " + ansi::paint(kAccent, log.message);
}

int CopyTradeLogger::subscribe(Listener listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  const int id = next_listener_id_++;
  listeners_.emplace(id, std::move(listener));
  return id;
}

void CopyTradeLogger::unsubscribe(int id) {
  std::lock_guard<std::mutex> lock(mutex_);
  listeners_.erase(id);
}

}  // namespace eclipse::copytrade
