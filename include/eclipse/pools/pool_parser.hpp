#pragma once

#include <optional>

#include "eclipse/net/rpc_client.hpp"
#include "eclipse/pools/pool_accounts.hpp"

namespace eclipse::pools {

/// Decodes a Raydium AMM v4 pool account and resolves its OpenBook market into
/// the full account set a swap needs. Two RPC round trips: the pool, then the
/// market.
std::optional<PoolAccounts> parse_pool_info(net::RpcClient& client,
                                            const Pubkey& pool_address);

/// Decodes only the pool state, without the market lookup. Used when scanning
/// many pools and only the mints and vaults matter.
struct RaydiumPoolState {
  Pubkey base_mint;
  Pubkey quote_mint;
  Pubkey base_vault;
  Pubkey quote_vault;
  Pubkey open_orders;
  Pubkey target_orders;
  Pubkey market_id;
  Pubkey market_program_id;
  int base_decimals = 0;
  int quote_decimals = 0;
};

std::optional<RaydiumPoolState> decode_pool_state(
    const std::vector<std::uint8_t>& data);

/// Derives the OpenBook vault signer, which is a program address over the
/// market and its nonce rather than a stored field.
std::optional<Pubkey> derive_vault_signer(const Pubkey& market,
                                          std::uint64_t nonce);

}  // namespace eclipse::pools
