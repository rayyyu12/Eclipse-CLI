#pragma once

#include <chrono>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace eclipse::copytrade {

enum class CopyLogType { Info, Success, Error };
const char* to_string(CopyLogType type);

struct CopyTradeLog {
  std::chrono::system_clock::time_point timestamp;
  CopyLogType type = CopyLogType::Info;
  std::string protocol;  ///< "pump", "raydium" or "system"
  std::string message;
  std::vector<std::pair<std::string, std::string>> details;
};

/// The copy trader's activity feed, shown by Copy Trade > View Logs.
///
/// Kept in memory (the last 1000 entries) rather than going to the console:
/// copies execute on background threads while the menu owns the screen. Every
/// entry is also written to the main log file. A listener can watch for new
/// entries, which is how the log view updates live.
class CopyTradeLogger {
 public:
  using Details = std::vector<std::pair<std::string, std::string>>;
  using Listener = std::function<void(const CopyTradeLog&)>;

  static CopyTradeLogger& instance();

  void add(CopyLogType type, const std::string& protocol,
           const std::string& message, Details details = {});

  /// The most recent `count` entries, oldest first; every entry when 0.
  std::vector<CopyTradeLog> get(std::size_t count = 0) const;
  void clear();

  /// "time [TYPE] protocol: message", coloured.
  static std::string format(const CopyTradeLog& log);

  /// Called on the logging thread for every new entry. Returns an id for
  /// unsubscribe().
  int subscribe(Listener listener);
  void unsubscribe(int id);

 private:
  CopyTradeLogger() = default;

  static constexpr std::size_t kMaxLogs = 1000;

  mutable std::mutex mutex_;
  std::deque<CopyTradeLog> logs_;
  std::map<int, Listener> listeners_;
  int next_listener_id_ = 1;
};

}  // namespace eclipse::copytrade
