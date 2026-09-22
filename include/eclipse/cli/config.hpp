#pragma once

namespace eclipse::config {

inline constexpr int kMenuWidth = 60;
inline constexpr double kMinSolAmount = 0.0;
inline constexpr double kMaxSolAmount = 100000.0;
inline constexpr double kDefaultSlippage = 0.01;

namespace command {
inline constexpr const char* kBuy = "1";
inline constexpr const char* kSell = "2";
inline constexpr const char* kPositions = "3";
inline constexpr const char* kBalance = "4";
inline constexpr const char* kTransfer = "5";
inline constexpr const char* kCopyTrade = "6";
inline constexpr const char* kSettings = "7";
inline constexpr const char* kExit = "8";
}  // namespace command

namespace colors {
inline constexpr const char* kPrimary = "#FF9277";    // coral / peach
inline constexpr const char* kSecondary = "#2A2A2A";  // near black
inline constexpr const char* kAccent = "#F5E6DE";     // cream
inline constexpr const char* kBackground = "#D3D3D3"; // silver
inline constexpr const char* kError = "#b52b40";      // red
inline constexpr const char* kWarning = "#b52b40";
inline constexpr const char* kSuccess = "#D3D3FF";    // lavender
inline constexpr const char* kLogo = "#e29393";
}  // namespace colors

inline constexpr const char* kAsciiBanner = R"(
███████╗ ██████╗██╗     ██╗██████╗ ███████╗███████╗
██╔════╝██╔════╝██║     ██║██╔══██╗██╔════╝██╔════╝
█████╗  ██║     ██║     ██║██████╔╝███████╗█████╗
██╔══╝  ██║     ██║     ██║██╔═══╝ ╚════██║██╔══╝
███████╗╚██████╗███████╗██║██║     ███████║███████╗
╚══════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚══════╝╚══════╝
)";

}  // namespace eclipse::config
