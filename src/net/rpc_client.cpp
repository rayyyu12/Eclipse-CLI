#include "eclipse/net/rpc_client.hpp"

#include <openssl/evp.h>

#include <utility>

#include "eclipse/common/base58.hpp"
#include "eclipse/common/logger.hpp"
#include "eclipse/net/http_client.hpp"

namespace eclipse::net {
namespace {

std::string base64_encode(const std::vector<std::uint8_t>& bytes) {
  if (bytes.empty()) return {};
  // 4 output chars per 3 input bytes, plus padding and a NUL.
  std::string out((bytes.size() + 2) / 3 * 4 + 1, '\0');
  const int written = EVP_EncodeBlock(
      reinterpret_cast<unsigned char*>(out.data()), bytes.data(),
      static_cast<int>(bytes.size()));
  if (written < 0) return {};
  out.resize(static_cast<std::size_t>(written));
  return out;
}

std::vector<std::uint8_t> base64_decode(const std::string& text) {
  if (text.empty()) return {};
  std::vector<std::uint8_t> out(text.size() / 4 * 3 + 3, 0);
  const int written =
      EVP_DecodeBlock(out.data(), reinterpret_cast<const unsigned char*>(
                                     text.data()),
                      static_cast<int>(text.size()));
  if (written < 0) return {};
  out.resize(static_cast<std::size_t>(written));

  // EVP_DecodeBlock always reports a multiple of three; strip the padding the
  // original encoding added.
  std::size_t padding = 0;
  if (text.size() >= 2) {
    if (text[text.size() - 1] == '=') ++padding;
    if (text[text.size() - 2] == '=') ++padding;
  }
  if (out.size() >= padding) out.resize(out.size() - padding);
  return out;
}

}  // namespace

const char* to_string(Commitment commitment) {
  switch (commitment) {
    case Commitment::Processed: return "processed";
    case Commitment::Confirmed: return "confirmed";
    case Commitment::Finalized: return "finalized";
  }
  return "confirmed";
}

RpcClient::RpcClient(std::string endpoint, Commitment commitment)
    : endpoint_(std::move(endpoint)), commitment_(commitment) {}

std::optional<Json> RpcClient::call(const std::string& method,
                                    const Json& params) {
  last_error_.clear();

  const Json envelope = {{"jsonrpc", "2.0"},
                         {"id", ++request_id_},
                         {"method", method},
                         {"params", params}};

  const auto response =
      HttpClient::instance().post_json(endpoint_, envelope.dump());

  if (!response.error.empty()) {
    last_error_ = response.error;
    return std::nullopt;
  }
  if (response.rate_limited()) {
    // Expected under load. Callers back off rather than treat it as fatal.
    last_error_ = "429 rate limited";
    return std::nullopt;
  }
  if (!response.ok()) {
    last_error_ = "http " + std::to_string(response.status);
    return std::nullopt;
  }

  Json parsed = Json::parse(response.body, nullptr, false);
  if (parsed.is_discarded()) {
    last_error_ = "malformed JSON in response";
    return std::nullopt;
  }
  if (parsed.contains("error")) {
    last_error_ = parsed["error"].value("message", "rpc error");
    return std::nullopt;
  }
  if (!parsed.contains("result")) {
    last_error_ = "response had no result";
    return std::nullopt;
  }
  return parsed["result"];
}

std::optional<BlockhashInfo> RpcClient::get_latest_blockhash() {
  auto result = call("getLatestBlockhash",
                     Json::array({{{"commitment", to_string(commitment_)}}}));
  if (!result || !result->contains("value")) return std::nullopt;

  const auto& value = (*result)["value"];
  BlockhashInfo info;
  info.blockhash = value.value("blockhash", "");
  info.last_valid_block_height =
      value.value("lastValidBlockHeight", std::uint64_t{0});

  if (info.blockhash.empty()) return std::nullopt;
  return info;
}

std::optional<std::uint64_t> RpcClient::get_balance(const Pubkey& address) {
  auto result = call("getBalance",
                     Json::array({address.to_base58(),
                                  {{"commitment", to_string(commitment_)}}}));
  if (!result || !result->contains("value")) return std::nullopt;
  return (*result)["value"].get<std::uint64_t>();
}

std::optional<std::uint64_t> RpcClient::get_block_height() {
  auto result = call("getBlockHeight",
                     Json::array({{{"commitment", to_string(commitment_)}}}));
  if (!result || !result->is_number_unsigned()) return std::nullopt;
  return result->get<std::uint64_t>();
}

std::optional<AccountInfo> RpcClient::get_account_info(const Pubkey& address) {
  auto result =
      call("getAccountInfo",
           Json::array({address.to_base58(),
                        {{"encoding", "base64"},
                         {"commitment", to_string(commitment_)}}}));
  if (!result || !result->contains("value") || (*result)["value"].is_null()) {
    return std::nullopt;
  }

  const auto& value = (*result)["value"];
  AccountInfo info;
  info.lamports = value.value("lamports", std::uint64_t{0});
  info.executable = value.value("executable", false);

  if (auto owner = Pubkey::try_parse(value.value("owner", ""))) {
    info.owner = *owner;
  }
  if (value.contains("data") && value["data"].is_array() &&
      !value["data"].empty()) {
    info.data = base64_decode(value["data"][0].get<std::string>());
  }
  return info;
}

std::optional<TokenAmount> RpcClient::get_token_account_balance(
    const Pubkey& account) {
  auto result = call("getTokenAccountBalance",
                     Json::array({account.to_base58(),
                                  {{"commitment", to_string(commitment_)}}}));
  if (!result || !result->contains("value")) return std::nullopt;

  const auto& value = (*result)["value"];
  TokenAmount amount;
  amount.amount = value.value("amount", "0");
  amount.decimals = value.value("decimals", 0);
  if (value.contains("uiAmount") && !value["uiAmount"].is_null()) {
    amount.ui_amount = value["uiAmount"].get<double>();
  }
  return amount;
}

std::optional<std::vector<TokenAccount>> RpcClient::get_token_accounts_by_owner(
    const Pubkey& owner) {
  static const std::string kTokenProgram =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  auto result = call("getTokenAccountsByOwner",
                     Json::array({owner.to_base58(),
                                  {{"programId", kTokenProgram}},
                                  {{"encoding", "jsonParsed"},
                                   {"commitment", to_string(commitment_)}}}));
  if (!result || !result->contains("value")) return std::nullopt;

  std::vector<TokenAccount> accounts;
  for (const auto& entry : (*result)["value"]) {
    const auto& info =
        entry["account"]["data"]["parsed"]["info"];

    TokenAccount account;
    if (auto address = Pubkey::try_parse(entry.value("pubkey", ""))) {
      account.address = *address;
    }
    if (auto mint = Pubkey::try_parse(info.value("mint", ""))) {
      account.mint = *mint;
    }

    const auto& amount = info["tokenAmount"];
    account.amount.amount = amount.value("amount", "0");
    account.amount.decimals = amount.value("decimals", 0);
    if (amount.contains("uiAmount") && !amount["uiAmount"].is_null()) {
      account.amount.ui_amount = amount["uiAmount"].get<double>();
    }

    accounts.push_back(std::move(account));
  }
  return accounts;
}

std::optional<std::vector<ProgramAccount>> RpcClient::get_program_accounts(
    const Pubkey& program_id, std::optional<std::size_t> data_size,
    const std::vector<MemcmpFilter>& filters) {
  Json filter_array = Json::array();
  if (data_size.has_value()) {
    filter_array.push_back({{"dataSize", *data_size}});
  }
  for (const auto& filter : filters) {
    filter_array.push_back(
        {{"memcmp",
          {{"offset", filter.offset}, {"bytes", filter.bytes_base58}}}});
  }

  Json options = {{"encoding", "base64"},
                  {"commitment", to_string(commitment_)}};
  if (!filter_array.empty()) options["filters"] = filter_array;

  auto result = call("getProgramAccounts",
                     Json::array({program_id.to_base58(), options}));
  if (!result || !result->is_array()) return std::nullopt;

  std::vector<ProgramAccount> accounts;
  for (const auto& entry : *result) {
    ProgramAccount account;
    if (auto address = Pubkey::try_parse(entry.value("pubkey", ""))) {
      account.address = *address;
    }
    const auto& data = entry["account"]["data"];
    if (data.is_array() && !data.empty()) {
      account.data = base64_decode(data[0].get<std::string>());
    }
    accounts.push_back(std::move(account));
  }
  return accounts;
}

std::optional<std::string> RpcClient::send_transaction(
    const std::vector<std::uint8_t>& wire_transaction, bool skip_preflight,
    int max_retries) {
  auto result = call(
      "sendTransaction",
      Json::array({base64_encode(wire_transaction),
                   {{"encoding", "base64"},
                    {"skipPreflight", skip_preflight},
                    {"maxRetries", max_retries},
                    {"preflightCommitment", to_string(commitment_)}}}));
  if (!result || !result->is_string()) return std::nullopt;
  return result->get<std::string>();
}

std::optional<Json> RpcClient::simulate_transaction(
    const std::vector<std::uint8_t>& wire_transaction) {
  return call("simulateTransaction",
              Json::array({base64_encode(wire_transaction),
                           {{"encoding", "base64"},
                            {"commitment", to_string(commitment_)},
                            {"replaceRecentBlockhash", true}}}));
}

std::optional<std::string> RpcClient::get_signature_status(
    const std::string& signature) {
  auto result =
      call("getSignatureStatuses",
           Json::array({Json::array({signature}),
                        {{"searchTransactionHistory", true}}}));
  if (!result || !result->contains("value")) return std::nullopt;

  const auto& value = (*result)["value"];
  if (!value.is_array() || value.empty() || value[0].is_null()) {
    return std::nullopt;
  }
  if (value[0].contains("err") && !value[0]["err"].is_null()) return "failed";
  return value[0].value("confirmationStatus", "processed");
}

std::optional<std::uint64_t> RpcClient::get_priority_fee_estimate(
    const std::vector<std::uint8_t>& wire_transaction) {
  // Helius-only method. A non-Helius endpoint answers with an error, which
  // call() turns into nullopt and the caller replaces with its default.
  auto result =
      call("getPriorityFeeEstimate",
           Json::array({{{"transaction", base64_encode(wire_transaction)},
                         {"options",
                          {{"priorityLevel", "HIGH"}, {"includeLogs", false}}}}}));
  if (!result || !result->contains("priorityFeeEstimate")) return std::nullopt;

  const auto& estimate = (*result)["priorityFeeEstimate"];
  if (!estimate.is_number()) return std::nullopt;
  return static_cast<std::uint64_t>(estimate.get<double>());
}

}  // namespace eclipse::net
