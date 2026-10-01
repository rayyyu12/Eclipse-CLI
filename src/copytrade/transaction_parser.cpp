#include "eclipse/copytrade/transaction_parser.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

#include "eclipse/common/logger.hpp"
#include "eclipse/solana/programs.hpp"
#include "eclipse/swaps/constants.hpp"

namespace eclipse::copytrade {
namespace {

constexpr const char* kRayLogMarker = "ray_log:";
constexpr const char* kRayLogPrefix = "ray_log: ";

/// SwapBaseIn's account list is 18 long when it carries the AMM target
/// orders account. The positions below assume that layout, as the TypeScript
/// build did; a shorter list would shift every slot, so it is not decoded.
constexpr std::size_t kRaydiumSwapAccountCount = 18;

const std::string& wsol_mint() {
  static const std::string mint = solana::native_mint().to_base58();
  return mint;
}

const std::string& pump_log_marker() {
  static const std::string marker =
      "Program " + swaps::pump_fun_program_id().to_base58();
  return marker;
}

const Pubkey* account_at(const TransactionUpdate& tx, std::size_t index) {
  return index < tx.account_keys.size() ? &tx.account_keys[index] : nullptr;
}

bool invokes(const TransactionUpdate& tx, const CompiledInstruction& ix,
             const Pubkey& program) {
  const Pubkey* id = account_at(tx, ix.program_id_index);
  return id != nullptr && *id == program;
}

/// The key in the instruction's `slot`th account position. nullopt when the
/// instruction is shorter, or the index points past the account list (which
/// the TypeScript build reported as "Invalid account at index").
std::optional<Pubkey> instruction_account(const TransactionUpdate& tx,
                                          const CompiledInstruction& ix,
                                          std::size_t slot) {
  if (slot >= ix.accounts.size()) return std::nullopt;
  const Pubkey* key = account_at(tx, ix.accounts[slot]);
  if (key == nullptr) return std::nullopt;
  return *key;
}

const CompiledInstruction* find_top_level(const TransactionUpdate& tx,
                                          const Pubkey& program) {
  for (const auto& ix : tx.instructions) {
    if (invokes(tx, ix, program)) return &ix;
  }
  return nullptr;
}

bool starts_with(const std::vector<std::uint8_t>& data,
                 const std::uint8_t (&prefix)[8]) {
  return data.size() >= sizeof(prefix) &&
         std::memcmp(data.data(), prefix, sizeof(prefix)) == 0;
}

const TokenBalance* find_by_mint(const std::vector<TokenBalance>& balances,
                                 const std::string& mint) {
  for (const auto& balance : balances) {
    if (balance.mint == mint) return &balance;
  }
  return nullptr;
}

const TokenBalance* find_by_index(const std::vector<TokenBalance>& balances,
                                  std::uint32_t account_index) {
  for (const auto& balance : balances) {
    if (balance.account_index == account_index) return &balance;
  }
  return nullptr;
}

}  // namespace

std::optional<std::string> extract_wallet_address(const TransactionUpdate& tx) {
  if (tx.account_keys.empty()) return std::nullopt;
  return tx.account_keys.front().to_base58();
}

bool is_pump_transaction(const TransactionUpdate& tx) {
  const std::string& marker = pump_log_marker();
  return std::any_of(tx.log_messages.begin(), tx.log_messages.end(),
                     [&marker](const std::string& line) {
                       return line.find(marker) != std::string::npos;
                     });
}

std::optional<std::string> find_ray_log(const TransactionUpdate& tx) {
  for (const auto& line : tx.log_messages) {
    if (line.find(kRayLogMarker) != std::string::npos) return line;
  }
  return std::nullopt;
}

// --- pump.fun ------------------------------------------------------------------

std::optional<PumpSwapData> extract_pump_swap_details(
    const TransactionUpdate& tx, const std::string& wallet_address) {
  const Pubkey& program = swaps::pump_fun_program_id();

  // A direct buy is a top-level instruction; one routed through a bot or
  // aggregator shows up as a CPI. Top level is checked first.
  const CompiledInstruction* ix = find_top_level(tx, program);
  if (ix == nullptr) {
    for (const auto& inner : tx.inner_instructions) {
      for (const auto& candidate : inner.instructions) {
        if (invokes(tx, candidate, program)) {
          ix = &candidate;
          break;
        }
      }
      if (ix != nullptr) break;
    }
  }
  if (ix == nullptr) return std::nullopt;

  const bool is_buy = starts_with(ix->data, swaps::kPumpBuyDiscriminator);
  const bool is_sell = starts_with(ix->data, swaps::kPumpSellDiscriminator);
  if (!is_buy && !is_sell) return std::nullopt;

  // Account order is the same for buy and sell up to the user's account:
  // global, fee recipient, mint, bonding curve, its token account, the user's
  // token account.
  const auto mint = instruction_account(tx, *ix, 2);
  const auto bonding_curve = instruction_account(tx, *ix, 3);
  const auto associated_bonding_curve = instruction_account(tx, *ix, 4);
  const auto user_token_account = instruction_account(tx, *ix, 5);
  if (!mint || !bonding_curve || !associated_bonding_curve ||
      !user_token_account) {
    Logger::instance().debug("TransactionMonitor",
                             "pump.fun instruction has too few accounts",
                             tx.signature);
    return std::nullopt;
  }

  // The first balance carrying the mint, before and after. A wallet buying for
  // the first time has no pre entry, which counts as zero.
  const std::string mint_text = mint->to_base58();
  const TokenBalance* pre = find_by_mint(tx.pre_token_balances, mint_text);
  const TokenBalance* post = find_by_mint(tx.post_token_balances, mint_text);
  if (post == nullptr) return std::nullopt;

  const double pre_amount = pre != nullptr ? pre->ui_token_amount.ui_amount : 0.0;
  const double token_amount =
      std::abs(post->ui_token_amount.ui_amount - pre_amount);

  // The SOL side is the wallet's lamport delta.
  const auto wallet = Pubkey::try_parse(wallet_address);
  if (!wallet.has_value()) return std::nullopt;

  const auto found =
      std::find(tx.account_keys.begin(), tx.account_keys.end(), *wallet);
  if (found == tx.account_keys.end()) return std::nullopt;

  const auto index =
      static_cast<std::size_t>(std::distance(tx.account_keys.begin(), found));
  if (index >= tx.pre_balances.size() || index >= tx.post_balances.size()) {
    return std::nullopt;
  }

  const std::uint64_t before = tx.pre_balances[index];
  const std::uint64_t after = tx.post_balances[index];
  const double sol_change =
      static_cast<double>(after > before ? after - before : before - after) /
      static_cast<double>(solana::kLamportsPerSol);

  PumpSwapData data;
  data.token_address = *mint;
  data.bonding_curve = *bonding_curve;
  data.associated_bonding_curve = *associated_bonding_curve;
  data.user_token_account = *user_token_account;
  data.wallet_address = wallet_address;
  data.signature = tx.signature;
  data.is_buy = is_buy;
  data.success = !tx.failed;
  data.amount_in = is_buy ? sol_change : token_amount;
  data.amount_out = is_buy ? token_amount : sol_change;
  data.decimals_in = is_buy ? 9 : 6;
  data.decimals_out = is_buy ? 6 : 9;
  data.timestamp = std::chrono::system_clock::now();
  return data;
}

// --- Raydium -------------------------------------------------------------------

std::optional<RaydiumInstructionAccounts> extract_raydium_pool_accounts(
    const TransactionUpdate& tx) {
  const CompiledInstruction* ix =
      find_top_level(tx, swaps::raydium_amm_program_id());
  if (ix == nullptr || ix->accounts.size() < kRaydiumSwapAccountCount) {
    return std::nullopt;
  }

  // Slots in SwapBaseIn order; slot 0 is the token program and 17 the signer.
  std::array<Pubkey, kRaydiumSwapAccountCount> keys;
  for (std::size_t slot = 1; slot <= 16; ++slot) {
    auto key = instruction_account(tx, *ix, slot);
    if (!key.has_value()) {
      Logger::instance().debug("TransactionMonitor",
                               "Raydium instruction references a missing "
                               "account",
                               tx.signature);
      return std::nullopt;
    }
    keys[slot] = *key;
  }

  RaydiumInstructionAccounts out;
  auto& pool = out.pool;
  pool.amm_id = keys[1];
  pool.amm_authority = keys[2];
  pool.amm_open_orders = keys[3];
  pool.amm_target_orders = keys[4];
  pool.pool_coin_token_account = keys[5];
  pool.pool_pc_token_account = keys[6];
  pool.serum_program_id = keys[7];
  pool.serum_market = keys[8];
  pool.serum_bids = keys[9];
  pool.serum_asks = keys[10];
  pool.serum_event_queue = keys[11];
  pool.serum_coin_vault_account = keys[12];
  pool.serum_pc_vault_account = keys[13];
  pool.serum_vault_signer = keys[14];
  out.leader_source_account = keys[15];
  out.leader_destination_account = keys[16];
  return out;
}

std::optional<TokenChanges> calculate_token_changes(
    const std::vector<TokenBalance>& pre, const std::vector<TokenBalance>& post) {
  // Keyed by mint in first-seen order, with a later account of the same mint
  // overwriting the earlier one: the semantics of the JavaScript Map the
  // TypeScript build used, which decide which entry counts as "the token".
  struct Change {
    std::string mint;
    double total_change = 0.0;
    std::uint32_t decimals = 0;
  };
  std::vector<Change> changes;

  for (const auto& after : post) {
    const TokenBalance* before = find_by_index(pre, after.account_index);
    if (before == nullptr || before->mint != after.mint) continue;

    Change change{after.mint,
                  after.ui_token_amount.ui_amount -
                      before->ui_token_amount.ui_amount,
                  after.ui_token_amount.decimals};

    auto existing = std::find_if(
        changes.begin(), changes.end(),
        [&after](const Change& c) { return c.mint == after.mint; });
    if (existing != changes.end()) {
      *existing = std::move(change);
    } else {
      changes.push_back(std::move(change));
    }
  }

  const auto token = std::find_if(
      changes.begin(), changes.end(),
      [](const Change& c) { return c.mint != wsol_mint(); });
  if (token == changes.end()) return std::nullopt;

  const auto token_mint = Pubkey::try_parse(token->mint);
  if (!token_mint.has_value()) return std::nullopt;

  const auto wsol = std::find_if(
      changes.begin(), changes.end(),
      [](const Change& c) { return c.mint == wsol_mint(); });
  const bool has_wsol = wsol != changes.end();
  const double wsol_delta = has_wsol ? wsol->total_change : 0.0;

  const bool is_buy = wsol_delta < 0.0 && token->total_change > 0.0;
  const double token_change = std::abs(token->total_change);
  const double wsol_change = std::abs(wsol_delta);

  std::optional<std::uint32_t> wsol_decimals;
  if (has_wsol) wsol_decimals = wsol->decimals;

  TokenChanges out;
  out.token_mint = *token_mint;
  out.token_in = is_buy ? wsol_mint() : token->mint;
  out.token_out = is_buy ? token->mint : wsol_mint();
  out.amount_in = is_buy ? wsol_change : token_change;
  out.amount_out = is_buy ? token_change : wsol_change;
  out.decimals_in = is_buy ? wsol_decimals : std::optional(token->decimals);
  out.decimals_out = is_buy ? std::optional(token->decimals) : wsol_decimals;
  return out;
}

SwapDetails extract_swap_details(const TransactionUpdate& tx,
                                 const std::string& wallet_address) {
  SwapDetails details;
  details.slot = tx.slot;

  for (const auto& before : tx.pre_token_balances) {
    if (before.owner != wallet_address) continue;
    const TokenBalance* after =
        find_by_index(tx.post_token_balances, before.account_index);

    UserTokenAccount account;
    account.pre_balance = before.ui_token_amount.ui_amount;
    account.post_balance =
        after != nullptr ? after->ui_token_amount.ui_amount : 0.0;
    account.decimals = before.ui_token_amount.decimals;
    account.mint = before.mint;
    details.user_accounts[std::to_string(before.account_index)] = account;
  }

  // The pool vaults are slots 5 (coin) and 6 (pc) of the swap instruction.
  const CompiledInstruction* ix =
      find_top_level(tx, swaps::raydium_amm_program_id());
  if (ix == nullptr || ix->accounts.size() <= 6) return details;

  const auto fill = [&tx](std::uint32_t index, PoolSideBalance& side) {
    const TokenBalance* before = find_by_index(tx.pre_token_balances, index);
    if (before == nullptr) return;
    const TokenBalance* after = find_by_index(tx.post_token_balances, index);
    side.pre = before->ui_token_amount.ui_amount;
    side.post = after != nullptr ? after->ui_token_amount.ui_amount : 0.0;
    side.decimals = before->ui_token_amount.decimals;
  };
  fill(ix->accounts[5], details.pool_balances.coin);
  fill(ix->accounts[6], details.pool_balances.pc);

  return details;
}

double calculate_token_change(const std::vector<TokenBalance>& pre,
                              const std::vector<TokenBalance>& post,
                              const std::string& mint) {
  const auto sum = [&mint](const std::vector<TokenBalance>& balances) {
    double total = 0.0;
    for (const auto& balance : balances) {
      if (balance.mint == mint) total += balance.ui_token_amount.ui_amount;
    }
    return total;
  };
  return sum(post) - sum(pre);
}

SwapDirection detect_swap_direction(const std::vector<TokenBalance>& pre,
                                    const std::vector<TokenBalance>& post,
                                    const PoolBalances& pool_balances) {
  const double coin_change = pool_balances.coin.post - pool_balances.coin.pre;
  const double pc_change = pool_balances.pc.post - pool_balances.pc.pre;

  // NOTE: kept exactly as the TypeScript build had it. These labels are right
  // when the coin vault holds WSOL. On a pool whose coin is the token and pc
  // is WSOL (the usual orientation for a graduated pump.fun token), a buy
  // drains the coin vault and fills the pc vault, which this reports as a
  // sell. Checking which vault's mint is WSOL would settle it; that is a
  // behaviour change, so it is flagged here rather than made silently.
  if (coin_change < 0.0 && pc_change > 0.0) return SwapDirection::Sell;
  if (coin_change > 0.0 && pc_change < 0.0) return SwapDirection::Buy;

  const double wsol_change = calculate_token_change(pre, post, wsol_mint());
  return wsol_change < 0.0 ? SwapDirection::Buy : SwapDirection::Sell;
}

// --- Entry point -----------------------------------------------------------------

std::optional<ParsedSwap> parse_swap(const TransactionUpdate& tx,
                                     const std::string& wallet_address) {
  // The venue comes from the logs rather than a lookup, so recognising the
  // trade costs no round trip.
  const bool is_pump = is_pump_transaction(tx);
  const auto ray_log = find_ray_log(tx);
  if (!is_pump && !ray_log.has_value()) return std::nullopt;

  if (is_pump) {
    auto data = extract_pump_swap_details(tx, wallet_address);
    if (!data.has_value()) return std::nullopt;
    return ParsedSwap{std::move(*data)};
  }

  auto accounts = extract_raydium_pool_accounts(tx);
  if (!accounts.has_value()) return std::nullopt;

  auto changes =
      calculate_token_changes(tx.pre_token_balances, tx.post_token_balances);
  if (!changes.has_value()) return std::nullopt;

  auto details = extract_swap_details(tx, wallet_address);
  const SwapDirection direction = detect_swap_direction(
      tx.pre_token_balances, tx.post_token_balances, details.pool_balances);

  RaydiumSwapData data;
  data.token_address = changes->token_mint;
  data.wallet_address = wallet_address;
  data.signature = tx.signature;
  data.is_buy = direction == SwapDirection::Buy;
  data.success = !tx.failed;
  data.amount_in = changes->amount_in;
  data.amount_out = changes->amount_out;
  data.timestamp = std::chrono::system_clock::now();

  data.pool = accounts->pool;
  data.leader_source_account = accounts->leader_source_account;
  data.leader_destination_account = accounts->leader_destination_account;

  data.token_in_mint = changes->token_in;
  data.token_out_mint = changes->token_out;
  data.decimals_in = changes->decimals_in;
  data.decimals_out = changes->decimals_out;

  data.pool_balances = details.pool_balances;
  data.user_accounts = std::move(details.user_accounts);
  data.slot = details.slot;

  const auto prefix = ray_log->find(kRayLogPrefix);
  if (prefix != std::string::npos) {
    data.ray_log_data = ray_log->substr(prefix + std::strlen(kRayLogPrefix));
  }

  return ParsedSwap{std::move(data)};
}

}  // namespace eclipse::copytrade
