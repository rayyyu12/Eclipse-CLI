#include "eclipse/fees/jito.hpp"

#include <openssl/evp.h>

#include <chrono>
#include <mutex>
#include <nlohmann/json.hpp>
#include <random>

#include "eclipse/common/logger.hpp"
#include "eclipse/net/http_client.hpp"
#include "eclipse/solana/programs.hpp"

namespace eclipse::fees {
namespace {

using Json = nlohmann::json;

constexpr const char* kTipFloorUrl =
    "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
constexpr const char* kBlockEngineUrl =
    "https://mainnet.block-engine.jito.wtf/api/v1/transactions";

constexpr auto kTipCacheDuration = std::chrono::seconds(30);
constexpr std::uint64_t kMinimumTipLamports = 1000;

/// The eight accounts Jito publishes for tips.
const std::vector<Pubkey>& tip_accounts() {
  static const std::vector<Pubkey> accounts = {
      Pubkey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
      Pubkey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
      Pubkey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
      Pubkey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
      Pubkey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
      Pubkey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
      Pubkey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
      Pubkey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"),
  };
  return accounts;
}

std::string base64_encode(const std::vector<std::uint8_t>& bytes) {
  std::string out((bytes.size() + 2) / 3 * 4 + 1, '\0');
  const int written = EVP_EncodeBlock(
      reinterpret_cast<unsigned char*>(out.data()), bytes.data(),
      static_cast<int>(bytes.size()));
  if (written < 0) return {};
  out.resize(static_cast<std::size_t>(written));
  return out;
}

std::mutex g_tip_mutex;
std::optional<TipFloor> g_cached_tip;
std::chrono::steady_clock::time_point g_tip_fetched_at;

}  // namespace

const Pubkey& random_tip_account() {
  static thread_local std::mt19937 rng{std::random_device{}()};
  const auto& accounts = tip_accounts();

  std::uniform_int_distribution<std::size_t> pick(0, accounts.size() - 1);
  return accounts[pick(rng)];
}

std::optional<TipFloor> get_tip_floor() {
  {
    std::lock_guard<std::mutex> lock(g_tip_mutex);
    if (g_cached_tip.has_value() &&
        std::chrono::steady_clock::now() - g_tip_fetched_at <
            kTipCacheDuration) {
      return g_cached_tip;
    }
  }

  const auto response = net::HttpClient::instance().get(kTipFloorUrl);
  if (!response.ok()) {
    Logger::instance().debug("Jito", "Tip floor unavailable",
                             response.error.empty()
                                 ? "http " + std::to_string(response.status)
                                 : response.error);
    return std::nullopt;
  }

  Json parsed = Json::parse(response.body, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_array() || parsed.empty()) {
    return std::nullopt;
  }

  const auto& entry = parsed[0];
  TipFloor floor;
  floor.p25 = entry.value("landed_tips_25th_percentile", 0.0);
  floor.p50 = entry.value("landed_tips_50th_percentile", 0.0);
  floor.p75 = entry.value("landed_tips_75th_percentile", 0.0);
  floor.p95 = entry.value("landed_tips_95th_percentile", 0.0);
  floor.ema_p50 = entry.value("ema_landed_tips_50th_percentile", 0.0);

  {
    std::lock_guard<std::mutex> lock(g_tip_mutex);
    g_cached_tip = floor;
    g_tip_fetched_at = std::chrono::steady_clock::now();
  }
  return floor;
}

std::uint64_t resolve_tip_lamports(const cli::FeeSettings& settings) {
  if (!settings.use_automatic_jito_tip) {
    const double sol = settings.fixed_jito_tip_amount.value_or(0.0);
    const auto lamports = static_cast<std::uint64_t>(
        sol * static_cast<double>(solana::kLamportsPerSol));
    return std::max(lamports, kMinimumTipLamports);
  }

  const auto floor = get_tip_floor();
  if (!floor.has_value()) {
    // No floor to read: fall back to the configured amount, or the minimum.
    const double sol = settings.fixed_jito_tip_amount.value_or(0.0);
    const auto lamports = static_cast<std::uint64_t>(
        sol * static_cast<double>(solana::kLamportsPerSol));
    return std::max(lamports, kMinimumTipLamports);
  }

  double chosen = floor->p50;
  switch (settings.jito_tip_aggressiveness) {
    case cli::TipAggressiveness::Low:    chosen = floor->p25; break;
    case cli::TipAggressiveness::Medium: chosen = floor->p50; break;
    case cli::TipAggressiveness::High:   chosen = floor->p95; break;
  }

  // The EMA is steadier than the instantaneous percentile; take whichever is
  // higher so a quiet moment does not produce a tip that cannot land.
  chosen = std::max(chosen, floor->ema_p50);

  const auto lamports = static_cast<std::uint64_t>(
      chosen * static_cast<double>(solana::kLamportsPerSol));
  return std::max(lamports, kMinimumTipLamports);
}

solana::Instruction build_tip_instruction(const Pubkey& payer,
                                          std::uint64_t lamports) {
  return solana::system_program::transfer(payer, random_tip_account(),
                                          lamports);
}

std::optional<std::string> send_bundle(
    const std::vector<std::uint8_t>& wire_transaction) {
  const Json request = {
      {"jsonrpc", "2.0"},
      {"id", 1},
      {"method", "sendTransaction"},
      {"params", Json::array({base64_encode(wire_transaction),
                              {{"encoding", "base64"}}})}};

  const auto response =
      net::HttpClient::instance().post_json(kBlockEngineUrl, request.dump());

  if (!response.ok()) {
    Logger::instance().warn("Jito", "Bundle submission failed",
                            response.error.empty()
                                ? "http " + std::to_string(response.status)
                                : response.error);
    return std::nullopt;
  }

  // The bundle id comes back in a header; the body carries the signature.
  const auto header = response.headers.find("x-bundle-id");
  if (header != response.headers.end()) return header->second;

  Json parsed = Json::parse(response.body, nullptr, false);
  if (!parsed.is_discarded() && parsed.contains("result") &&
      parsed["result"].is_string()) {
    return parsed["result"].get<std::string>();
  }
  return std::nullopt;
}

}  // namespace eclipse::fees
