#include "eclipse/pools/pool_selector.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <limits>

#include "eclipse/common/logger.hpp"
#include "eclipse/pools/pool_discovery.hpp"

namespace eclipse::pools {
namespace {

/// 128-bit intermediate so base*quote cannot wrap. Reserves routinely exceed
/// 2^32, and their product would overflow 64 bits.
using u128 = unsigned __int128;

std::optional<std::uint64_t> parse_u64(const std::string& text) {
  if (text.empty()) return std::nullopt;

  u128 value = 0;
  for (char c : text) {
    if (c < '0' || c > '9') return std::nullopt;
    value = value * 10 + static_cast<unsigned>(c - '0');
    if (value > std::numeric_limits<std::uint64_t>::max()) return std::nullopt;
  }
  return static_cast<std::uint64_t>(value);
}

}  // namespace

std::uint64_t constant_product_output(std::uint64_t amount_in,
                                      std::uint64_t base_reserve,
                                      std::uint64_t quote_reserve) {
  if (amount_in == 0 || base_reserve == 0 || quote_reserve == 0) return 0;

  const u128 k = static_cast<u128>(base_reserve) * quote_reserve;
  const u128 new_base = static_cast<u128>(base_reserve) + amount_in;

  // A large enough input floors the division to zero, which would quote the
  // entire reserve as available. A pool can never be fully drained, so the
  // remaining side is held at one base unit.
  const u128 new_quote = std::max<u128>(k / new_base, 1);

  if (new_quote >= quote_reserve) return 0;
  return static_cast<std::uint64_t>(quote_reserve - new_quote);
}

std::optional<PoolQuote> quote_pool(net::RpcClient& client,
                                    const PoolAccounts& pool,
                                    std::uint64_t amount_in) {
  auto base = client.get_token_account_balance(pool.pool_coin_token_account);
  auto quote = client.get_token_account_balance(pool.pool_pc_token_account);
  if (!base.has_value() || !quote.has_value()) return std::nullopt;

  const auto base_reserve = parse_u64(base->amount);
  const auto quote_reserve = parse_u64(quote->amount);
  if (!base_reserve.has_value() || !quote_reserve.has_value()) {
    return std::nullopt;
  }

  PoolQuote result;
  result.pool = pool;
  result.base_reserve = *base_reserve;
  result.quote_reserve = *quote_reserve;
  result.expected_output =
      constant_product_output(amount_in, *base_reserve, *quote_reserve);

  if (result.expected_output == 0) return std::nullopt;

  // Impact is the shortfall against a trade at the pool's spot price.
  if (*base_reserve > 0) {
    const double spot = static_cast<double>(*quote_reserve) /
                        static_cast<double>(*base_reserve);
    const double ideal = static_cast<double>(amount_in) * spot;
    if (ideal > 0.0) {
      result.price_impact_percent =
          (1.0 - static_cast<double>(result.expected_output) / ideal) * 100.0;
    }
  }

  return result;
}

std::optional<PoolQuote> get_best_pool(net::RpcClient& client,
                                       const Pubkey& input_mint,
                                       std::uint64_t amount_in) {
  auto& logger = Logger::instance();

  const auto pools = find_all_pools(client, input_mint);
  if (pools.empty()) {
    logger.debug("PoolSelector",
                 "No pools found for " + input_mint.to_base58());
    return std::nullopt;
  }

  std::optional<PoolQuote> best;
  for (const auto& pool : pools) {
    auto quote = quote_pool(client, pool, amount_in);
    if (!quote.has_value()) continue;

    if (!best.has_value() || quote->expected_output > best->expected_output) {
      best = std::move(quote);
    }
  }

  if (best.has_value()) {
    logger.debug("PoolSelector",
                 "Best of " + std::to_string(pools.size()) + " pool(s): " +
                     best->pool.amm_id.to_base58());
  }
  return best;
}

std::string format_amount(std::uint64_t amount, int decimals) {
  if (decimals <= 0) return std::to_string(amount);

  std::uint64_t divisor = 1;
  for (int i = 0; i < decimals; ++i) divisor *= 10;

  const std::uint64_t whole = amount / divisor;
  const std::uint64_t fraction = amount % divisor;

  std::string fraction_text = std::to_string(fraction);
  fraction_text.insert(0, static_cast<std::size_t>(decimals) -
                              fraction_text.size(),
                       '0');

  while (!fraction_text.empty() && fraction_text.back() == '0') {
    fraction_text.pop_back();
  }

  if (fraction_text.empty()) return std::to_string(whole);
  return std::to_string(whole) + "." + fraction_text;
}

std::optional<std::uint64_t> parse_amount(const std::string& text,
                                          int decimals) {
  if (text.empty() || decimals < 0) return std::nullopt;

  const auto dot = text.find('.');
  const std::string whole_part = text.substr(0, dot);
  std::string fraction_part =
      dot == std::string::npos ? "" : text.substr(dot + 1);

  if (fraction_part.size() > static_cast<std::size_t>(decimals)) {
    // Extra precision would be silently dropped, which is worse than a clear
    // rejection when the number is an order amount.
    return std::nullopt;
  }
  fraction_part.append(static_cast<std::size_t>(decimals) -
                           fraction_part.size(),
                       '0');

  const auto whole = parse_u64(whole_part.empty() ? "0" : whole_part);
  const auto fraction = parse_u64(fraction_part.empty() ? "0" : fraction_part);
  if (!whole.has_value() || !fraction.has_value()) return std::nullopt;

  u128 scale = 1;
  for (int i = 0; i < decimals; ++i) scale *= 10;

  const u128 total = static_cast<u128>(*whole) * scale + *fraction;
  if (total > std::numeric_limits<std::uint64_t>::max()) return std::nullopt;
  return static_cast<std::uint64_t>(total);
}

}  // namespace eclipse::pools
