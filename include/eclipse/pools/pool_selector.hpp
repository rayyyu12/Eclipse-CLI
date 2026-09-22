#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/pool_accounts.hpp"

namespace eclipse::pools {

struct PoolQuote {
  PoolAccounts pool;
  std::uint64_t expected_output = 0;
  double price_impact_percent = 0.0;
  std::uint64_t base_reserve = 0;
  std::uint64_t quote_reserve = 0;
};

/// Constant-product output for a swap against the given reserves.
///
///     k = base * quote
///     out = quote - k / (base + in)
///
/// This ignores the 0.25% Raydium fee, so it is a ceiling on what the pool
/// will actually return; slippage covers the difference.
std::uint64_t constant_product_output(std::uint64_t amount_in,
                                      std::uint64_t base_reserve,
                                      std::uint64_t quote_reserve);

/// Quotes one pool by reading both vault balances.
std::optional<PoolQuote> quote_pool(net::RpcClient& client,
                                    const PoolAccounts& pool,
                                    std::uint64_t amount_in);

/// Quotes every pool holding the mint and returns the one with the best
/// output. nullopt when nothing quotable is found.
std::optional<PoolQuote> get_best_pool(net::RpcClient& client,
                                       const Pubkey& input_mint,
                                       std::uint64_t amount_in);

/// Renders a raw amount with its decimal point, trimming trailing zeros.
std::string format_amount(std::uint64_t amount, int decimals);

/// Parses a decimal string into base units. nullopt on malformed input or
/// overflow.
std::optional<std::uint64_t> parse_amount(const std::string& text,
                                          int decimals);

}  // namespace eclipse::pools
