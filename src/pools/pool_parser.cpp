#include "eclipse/pools/pool_parser.hpp"

#include "eclipse/common/logger.hpp"
#include "eclipse/solana/instruction.hpp"
#include "eclipse/swaps/constants.hpp"
#include "eclipse/swaps/swap_builder.hpp"

namespace eclipse::pools {
namespace {
namespace ray = swaps::raydium_v4_offset;
namespace book = swaps::openbook_offset;
}  // namespace

std::optional<RaydiumPoolState> decode_pool_state(
    const std::vector<std::uint8_t>& data) {
  if (data.size() < swaps::kRaydiumLiquidityStateV4Size) return std::nullopt;

  RaydiumPoolState state;
  state.base_decimals =
      static_cast<int>(solana::read_u64(data, ray::kBaseDecimal));
  state.quote_decimals =
      static_cast<int>(solana::read_u64(data, ray::kQuoteDecimal));
  state.base_vault = solana::read_pubkey(data, ray::kBaseVault);
  state.quote_vault = solana::read_pubkey(data, ray::kQuoteVault);
  state.base_mint = solana::read_pubkey(data, ray::kBaseMint);
  state.quote_mint = solana::read_pubkey(data, ray::kQuoteMint);
  state.open_orders = solana::read_pubkey(data, ray::kOpenOrders);
  state.target_orders = solana::read_pubkey(data, ray::kTargetOrders);
  state.market_id = solana::read_pubkey(data, ray::kMarketId);
  state.market_program_id = solana::read_pubkey(data, ray::kMarketProgramId);

  // An all-zero base mint means the slot is uninitialised rather than a pool.
  if (state.base_mint.is_default() || state.quote_mint.is_default()) {
    return std::nullopt;
  }
  return state;
}

std::optional<Pubkey> derive_vault_signer(const Pubkey& market,
                                          std::uint64_t nonce) {
  // Seeds are the market address and the nonce as little-endian u64. This is
  // createProgramAddress, not findProgramAddress: the nonce is stored in the
  // market, so there is no bump to search for.
  std::vector<std::uint8_t> nonce_seed;
  solana::put_u64(nonce_seed, nonce);

  return Pubkey::create_program_address(
      {std::vector<std::uint8_t>(market.bytes().begin(), market.bytes().end()),
       nonce_seed},
      swaps::openbook_program_id());
}

std::optional<PoolAccounts> parse_pool_info(net::RpcClient& client,
                                            const Pubkey& pool_address) {
  auto& logger = Logger::instance();

  auto pool_account = client.get_account_info(pool_address);
  if (!pool_account.has_value()) {
    logger.warn("PoolParser",
                "Pool account not found: " + pool_address.to_base58(),
                client.last_error());
    return std::nullopt;
  }

  auto state = decode_pool_state(pool_account->data);
  if (!state.has_value()) {
    logger.warn("PoolParser",
                "Pool account did not decode as Raydium v4: " +
                    pool_address.to_base58());
    return std::nullopt;
  }

  auto market_account = client.get_account_info(state->market_id);
  if (!market_account.has_value() ||
      market_account->data.size() < book::kAsks + Pubkey::kSize) {
    logger.warn("PoolParser",
                "OpenBook market not found: " + state->market_id.to_base58());
    return std::nullopt;
  }

  const auto& market = market_account->data;
  const std::uint64_t nonce = solana::read_u64(market, book::kVaultSignerNonce);

  auto vault_signer = derive_vault_signer(state->market_id, nonce);
  if (!vault_signer.has_value()) {
    logger.warn("PoolParser", "Could not derive OpenBook vault signer for " +
                                  state->market_id.to_base58());
    return std::nullopt;
  }

  PoolAccounts accounts;
  accounts.id = state->base_mint.to_base58() + "/" +
                state->quote_mint.to_base58();
  accounts.amm_id = pool_address;
  accounts.amm_authority = swaps::raydium_amm_authority();
  accounts.amm_open_orders = state->open_orders;
  accounts.amm_target_orders = state->target_orders;
  accounts.pool_coin_token_account = state->base_vault;
  accounts.pool_pc_token_account = state->quote_vault;

  accounts.serum_program_id = swaps::openbook_program_id();
  accounts.serum_market = state->market_id;
  accounts.serum_bids = solana::read_pubkey(market, book::kBids);
  accounts.serum_asks = solana::read_pubkey(market, book::kAsks);
  accounts.serum_event_queue = solana::read_pubkey(market, book::kEventQueue);
  accounts.serum_coin_vault_account =
      solana::read_pubkey(market, book::kBaseVault);
  accounts.serum_pc_vault_account =
      solana::read_pubkey(market, book::kQuoteVault);
  accounts.serum_vault_signer = *vault_signer;

  accounts.base_mint = state->base_mint;
  accounts.quote_mint = state->quote_mint;
  accounts.base_decimals = state->base_decimals;
  accounts.quote_decimals = state->quote_decimals;

  return accounts;
}

}  // namespace eclipse::pools
