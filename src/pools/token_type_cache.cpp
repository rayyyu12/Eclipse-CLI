#include "eclipse/pools/token_type_cache.hpp"

#include <fstream>
#include <nlohmann/json.hpp>

#include "eclipse/common/logger.hpp"
#include "eclipse/pools/pool_discovery.hpp"
#include "eclipse/solana/instruction.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/swaps/constants.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace eclipse::pools {
namespace {

using Json = nlohmann::json;

constexpr const char* kCacheFile = "token-types-cache.json";
constexpr auto kTtl = std::chrono::hours(1);

std::int64_t to_epoch(std::chrono::system_clock::time_point tp) {
  return std::chrono::duration_cast<std::chrono::seconds>(
             tp.time_since_epoch())
      .count();
}

}  // namespace

const char* to_string(TokenType type) {
  switch (type) {
    case TokenType::PumpFun:  return "pumpfun";
    case TokenType::Raydium:  return "raydium";
    case TokenType::Unknown:  return "unknown";
  }
  return "unknown";
}

bool TokenTypeInfo::expired() const {
  return std::chrono::system_clock::now() - checked_at > kTtl;
}

TokenTypeCache& TokenTypeCache::instance() {
  static TokenTypeCache cache;
  return cache;
}

TokenTypeCache::TokenTypeCache() : path_(kCacheFile) { load(); }

void TokenTypeCache::load() {
  std::ifstream file(path_);
  if (!file.is_open()) return;

  Json parsed = Json::parse(file, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_object()) return;

  const auto now = std::chrono::system_clock::now();
  for (const auto& [mint, entry] : parsed.items()) {
    TokenTypeInfo info;

    const std::string type = entry.value("type", "unknown");
    info.type = type == "pumpfun"   ? TokenType::PumpFun
                : type == "raydium" ? TokenType::Raydium
                                    : TokenType::Unknown;
    info.has_raydium_pool = entry.value("hasRaydiumPool", false);
    info.checked_at = std::chrono::system_clock::time_point(
        std::chrono::seconds(entry.value("checkedAt", to_epoch(now))));

    if (!info.expired()) cache_.emplace(mint, info);
  }
}

void TokenTypeCache::flush() const {
  Json out = Json::object();
  for (const auto& [mint, info] : cache_) {
    out[mint] = {{"type", to_string(info.type)},
                 {"hasRaydiumPool", info.has_raydium_pool},
                 {"checkedAt", to_epoch(info.checked_at)}};
  }

  std::ofstream file(path_);
  if (file.is_open()) file << out.dump(2) << '\n';
}

std::optional<TokenTypeInfo> TokenTypeCache::get(
    const std::string& mint) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto found = cache_.find(mint);
  if (found == cache_.end() || found->second.expired()) return std::nullopt;
  return found->second;
}

void TokenTypeCache::set(const std::string& mint, TokenType type,
                         bool has_raydium_pool) {
  std::lock_guard<std::mutex> lock(mutex_);
  cache_[mint] = TokenTypeInfo{type, has_raydium_pool,
                               std::chrono::system_clock::now()};
  flush();
}

TokenTypeInfo TokenTypeCache::check(net::RpcClient& client,
                                    const Pubkey& mint) {
  const std::string key = mint.to_base58();
  if (auto cached = get(key)) return *cached;

  TokenTypeInfo info = probe(client, mint);
  set(key, info.type, info.has_raydium_pool);
  return info;
}

TokenTypeInfo TokenTypeCache::probe(net::RpcClient& client,
                                    const Pubkey& mint) {
  TokenTypeInfo info;
  info.checked_at = std::chrono::system_clock::now();

  // Pump.fun first: its bonding curve is a single deterministic account, so
  // the check is one round trip against a discovery scan for Raydium.
  auto curve = fetch_bonding_curve(client, mint);
  if (curve.has_value() && !curve->complete) {
    info.type = TokenType::PumpFun;
    Logger::instance().debug("TokenTypeCache",
                             mint.to_base58() + " is on the pump.fun curve");
    return info;
  }

  // A completed curve means the token graduated, so look for its Raydium pool.
  auto pool = discover_pool(client, solana::native_mint(), mint);
  if (pool.has_value()) {
    info.type = TokenType::Raydium;
    info.has_raydium_pool = true;
    return info;
  }

  if (curve.has_value()) {
    // Graduated but the pool is not indexed yet; pump.fun still routes it.
    info.type = TokenType::PumpFun;
    return info;
  }

  info.type = TokenType::Unknown;
  return info;
}

void TokenTypeCache::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  cache_.clear();
  flush();
}

std::optional<Pubkey> derive_bonding_curve(const Pubkey& mint) {
  static const std::string kSeed = "bonding-curve";

  auto derived = Pubkey::find_program_address(
      {std::vector<std::uint8_t>(kSeed.begin(), kSeed.end()),
       std::vector<std::uint8_t>(mint.bytes().begin(), mint.bytes().end())},
      swaps::pump_fun_program_id());

  if (!derived.has_value()) return std::nullopt;
  return derived->first;
}

std::optional<BondingCurveState> fetch_bonding_curve(net::RpcClient& client,
                                                     const Pubkey& mint) {
  auto address = derive_bonding_curve(mint);
  if (!address.has_value()) return std::nullopt;

  auto account = client.get_account_info(*address);
  if (!account.has_value()) return std::nullopt;

  const auto& data = account->data;
  if (data.size() < swaps::pump_offset::kComplete + 1) return std::nullopt;

  BondingCurveState state;
  state.address = *address;
  state.virtual_token_reserves =
      solana::read_u64(data, swaps::pump_offset::kVirtualTokenReserves);
  state.virtual_sol_reserves =
      solana::read_u64(data, swaps::pump_offset::kVirtualSolReserves);
  state.real_token_reserves =
      solana::read_u64(data, swaps::pump_offset::kRealTokenReserves);
  state.real_sol_reserves =
      solana::read_u64(data, swaps::pump_offset::kRealSolReserves);
  state.complete = data[swaps::pump_offset::kComplete] != 0;

  return state;
}

}  // namespace eclipse::pools
