#pragma once

#include <string>

#include "eclipse/common/pubkey.hpp"

namespace eclipse::pools {

/// The account set a Raydium AMM v4 swap needs, resolved from the pool state
/// and its OpenBook market.
struct PoolAccounts {
  std::string id;  ///< "baseMint/quoteMint"

  Pubkey amm_id;
  Pubkey amm_authority;
  Pubkey amm_open_orders;
  Pubkey amm_target_orders;
  Pubkey pool_coin_token_account;
  Pubkey pool_pc_token_account;

  Pubkey serum_program_id;
  Pubkey serum_market;
  Pubkey serum_bids;
  Pubkey serum_asks;
  Pubkey serum_event_queue;
  Pubkey serum_coin_vault_account;
  Pubkey serum_pc_vault_account;
  Pubkey serum_vault_signer;

  Pubkey base_mint;
  Pubkey quote_mint;
  int base_decimals = 0;
  int quote_decimals = 0;

  bool valid() const { return !amm_id.is_default(); }
};

}  // namespace eclipse::pools
