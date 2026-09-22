#pragma once

#include <cstdint>
#include <vector>

#include "eclipse/pools/pool_accounts.hpp"
#include "eclipse/solana/instruction.hpp"

namespace eclipse::swaps {

/// Raydium AMM v4 SwapBaseIn.
///
/// The account order is fixed by the program and must match exactly: token
/// program, AMM triple, pool vaults, the OpenBook market accounts, then the
/// user's source and destination accounts and the signer.
solana::Instruction build_raydium_swap(
    const Pubkey& wallet, const Pubkey& user_source_token_account,
    const Pubkey& user_destination_token_account,
    const pools::PoolAccounts& pool, std::uint64_t amount_in,
    std::uint64_t min_amount_out);

/// Creates a rent-exempt account owned by the token program and initialises it
/// as a wrapped-SOL account. Returned as a pair so the caller can close the
/// account in the same transaction and recover the rent.
std::vector<solana::Instruction> build_wrapped_sol_account(
    const Pubkey& wallet, const Pubkey& wsol_account, std::uint64_t lamports,
    std::uint64_t rent_exempt_minimum);

/// Compute unit limit the swap paths request. Raydium swaps through OpenBook
/// touch enough accounts that the 200k default is not sufficient.
inline constexpr std::uint32_t kSwapComputeUnitLimit = 1400000;

/// Applies a slippage tolerance expressed in percent.
std::uint64_t apply_slippage(std::uint64_t amount, double slippage_percent);

}  // namespace eclipse::swaps
