#pragma once

#include <optional>
#include <string>
#include <vector>

#include "eclipse/copytrade/types.hpp"

namespace eclipse::copytrade {

// Decoding of a followed wallet's transaction into the trade to copy.
//
// Everything is read from the transaction and its status meta as streamed:
// the venue from the program logs, the amounts from the balance deltas, and
// for Raydium the whole pool account set from the swap instruction itself.
// None of it touches the network, which is the point: by the time the copy
// starts, the only round trips left are the ones the copy cannot avoid.

/// The fee payer, which is the wallet that initiated the transaction.
std::optional<std::string> extract_wallet_address(const TransactionUpdate& tx);

/// True when a log line mentions the pump.fun program
/// ("Program 6EF8... invoke", "... success", "... consumed").
bool is_pump_transaction(const TransactionUpdate& tx);

/// The "ray_log:" line Raydium AMM v4 writes on every swap. Its presence is
/// how a Raydium trade is recognised.
std::optional<std::string> find_ray_log(const TransactionUpdate& tx);

/// The first pump.fun buy or sell, top-level or CPI. nullopt when the
/// instruction is neither, an account index is out of range, or either amount
/// cannot be worked out.
///
/// The SOL amount is the fee payer's lamport delta, so it includes the network
/// fee and any rent; the token amount is the delta of the first token balance
/// carrying the mint.
std::optional<PumpSwapData> extract_pump_swap_details(
    const TransactionUpdate& tx, const std::string& wallet_address);

/// The pool and OpenBook accounts from the first top-level Raydium AMM
/// instruction, by their fixed positions in SwapBaseIn's account list.
struct RaydiumInstructionAccounts {
  pools::PoolAccounts pool;
  Pubkey leader_source_account;
  Pubkey leader_destination_account;
};
std::optional<RaydiumInstructionAccounts> extract_raydium_pool_accounts(
    const TransactionUpdate& tx);

/// Net movement of the non-WSOL mint against WSOL across the transaction's
/// token balances.
struct TokenChanges {
  Pubkey token_mint;
  std::string token_in;
  std::string token_out;
  double amount_in = 0.0;
  double amount_out = 0.0;
  std::optional<std::uint32_t> decimals_in;
  std::optional<std::uint32_t> decimals_out;
};
std::optional<TokenChanges> calculate_token_changes(
    const std::vector<TokenBalance>& pre, const std::vector<TokenBalance>& post);

/// The followed wallet's token accounts and both pool vaults, before and after.
struct SwapDetails {
  std::map<std::string, UserTokenAccount> user_accounts;
  PoolBalances pool_balances;
  std::uint64_t slot = 0;
};
SwapDetails extract_swap_details(const TransactionUpdate& tx,
                                 const std::string& wallet_address);

enum class SwapDirection { Buy, Sell };

/// Reads the direction off the pool vaults: coin out and pc in is reported as
/// a sell, coin in and pc out as a buy. When the vaults are inconclusive, a
/// net WSOL outflow across all token balances means a buy.
///
/// Ported as written. Which vault holds SOL depends on the pool's orientation,
/// so on a pool whose base (coin) mint is the token rather than WSOL these
/// labels come out reversed; see the note in transaction_parser.cpp.
SwapDirection detect_swap_direction(const std::vector<TokenBalance>& pre,
                                    const std::vector<TokenBalance>& post,
                                    const PoolBalances& pool_balances);

/// Sum of post minus sum of pre across every balance carrying the mint.
double calculate_token_change(const std::vector<TokenBalance>& pre,
                              const std::vector<TokenBalance>& post,
                              const std::string& mint);

/// Everything the monitor does between "this is a followed wallet" and "copy
/// it": recognise the venue from the logs and decode the trade. nullopt when
/// the transaction is not a pump.fun or Raydium swap that decodes.
std::optional<ParsedSwap> parse_swap(const TransactionUpdate& tx,
                                     const std::string& wallet_address);

}  // namespace eclipse::copytrade
