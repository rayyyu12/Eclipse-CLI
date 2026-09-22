#include "eclipse/positions/report_card.hpp"

#include <iomanip>
#include <nlohmann/json.hpp>
#include <sstream>

#include "eclipse/cli/settings.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/net/http_client.hpp"

namespace eclipse::positions {
namespace {

std::string fixed(double value, int places) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(places) << value;
  return out.str();
}

/// SVG is XML: an unescaped mint or symbol would break the document.
std::string escape_xml(const std::string& text) {
  std::string out;
  out.reserve(text.size());
  for (char c : text) {
    switch (c) {
      case '&':  out += "&amp;";  break;
      case '<':  out += "&lt;";   break;
      case '>':  out += "&gt;";   break;
      case '"':  out += "&quot;"; break;
      case '\'': out += "&apos;"; break;
      default:   out += c;        break;
    }
  }
  return out;
}

}  // namespace

std::string render_position_card(const Position& position,
                                 double realized_profit_percent) {
  const bool profitable = realized_profit_percent >= 0.0;
  const char* accent = profitable ? "#4ade80" : "#f87171";
  const std::string sign = profitable ? "+" : "";

  std::ostringstream svg;
  svg << R"(<svg xmlns="http://www.w3.org/2000/svg" width="800" height="418" viewBox="0 0 800 418">)"
      << R"(<rect width="800" height="418" rx="20" fill="#12121a"/>)"
      << R"(<rect x="1" y="1" width="798" height="416" rx="19" fill="none" stroke=")"
      << accent << R"(" stroke-opacity="0.35" stroke-width="2"/>)"

      << R"(<text x="48" y="78" font-family="Menlo,monospace" font-size="20" fill="#6b7280" letter-spacing="4">ECLIPSE</text>)"

      << R"(<text x="48" y="160" font-family="Helvetica,Arial,sans-serif" font-size="42" font-weight="bold" fill="#f3f4f6">)"
      << escape_xml(position.symbol) << R"(</text>)"

      << R"(<text x="48" y="256" font-family="Helvetica,Arial,sans-serif" font-size="88" font-weight="bold" fill=")"
      << accent << R"(">)" << sign << fixed(realized_profit_percent, 2)
      << R"(%</text>)";

  const struct {
    const char* label;
    std::string value;
    int x;
  } stats[] = {
      {"ENTRY", fixed(position.average_entry_price, 8) + " SOL", 48},
      {"EXIT", fixed(position.current_price, 8) + " SOL", 296},
      {"REALIZED", fixed(position.realized_pnl_sol, 4) + " SOL", 544},
  };

  for (const auto& stat : stats) {
    svg << R"(<text x=")" << stat.x
        << R"(" y="332" font-family="Menlo,monospace" font-size="15" fill="#6b7280" letter-spacing="2">)"
        << stat.label << R"(</text>)"
        << R"(<text x=")" << stat.x
        << R"(" y="364" font-family="Menlo,monospace" font-size="20" fill="#d1d5db">)"
        << escape_xml(stat.value) << R"(</text>)";
  }

  svg << R"(<text x="48" y="398" font-family="Menlo,monospace" font-size="13" fill="#4b5563">)"
      << escape_xml(position.mint) << R"(</text>)"
      << R"(</svg>)";

  return svg.str();
}

bool post_position_card(const Position& position,
                        double realized_profit_percent) {
  const auto settings = cli::SettingsManager::instance().get();
  const auto& notifications = settings.notifications;

  if (!notifications.enable_discord_webhook ||
      !notifications.notify_on_trades ||
      !notifications.discord_webhook_url.has_value() ||
      notifications.discord_webhook_url->empty()) {
    return false;
  }

  const std::string svg =
      render_position_card(position, realized_profit_percent);

  const bool profitable = realized_profit_percent >= 0.0;
  const nlohmann::json payload = {
      {"embeds",
       nlohmann::json::array(
           {{{"title", std::string(profitable ? "Closed in profit"
                                              : "Closed at a loss")},
             {"description", position.symbol + " — " +
                                 (profitable ? "+" : "") +
                                 fixed(realized_profit_percent, 2) + "%"},
             {"color", profitable ? 0x4ade80 : 0xf87171}}})}};

  const std::vector<std::uint8_t> bytes(svg.begin(), svg.end());

  const auto response = net::HttpClient::instance().post_multipart_png(
      *notifications.discord_webhook_url, "files[0]", "position.svg", bytes,
      payload.dump());

  if (!response.ok()) {
    Logger::instance().warn("ReportCard", "Webhook post failed",
                            response.error.empty()
                                ? "http " + std::to_string(response.status)
                                : response.error);
    return false;
  }
  return true;
}

}  // namespace eclipse::positions
