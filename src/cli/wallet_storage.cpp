#include "eclipse/cli/wallet_storage.hpp"

#include <nlohmann/json.hpp>

#include "eclipse/cli/secure_storage.hpp"
#include "eclipse/cli/validation.hpp"
#include "eclipse/common/logger.hpp"

namespace eclipse::cli {
namespace {
using Json = nlohmann::json;
}

WalletStorage& WalletStorage::instance() {
  static WalletStorage storage;
  return storage;
}

std::set<std::string> WalletStorage::get() const {
  const auto stored = SecureStorage::instance().get().tracked_wallets;
  if (!stored.has_value() || stored->empty()) return {};

  Json parsed = Json::parse(*stored, nullptr, false);
  if (parsed.is_discarded() || !parsed.is_array()) {
    Logger::instance().warn("WalletStorage",
                            "Tracked wallet list was unreadable; ignoring it");
    return {};
  }

  std::set<std::string> wallets;
  for (const auto& entry : parsed) {
    if (entry.is_string()) wallets.insert(entry.get<std::string>());
  }
  return wallets;
}

void WalletStorage::save(const std::set<std::string>& wallets) {
  Json array = Json::array();
  for (const auto& wallet : wallets) array.push_back(wallet);
  SecureStorage::instance().set("trackedWallets", array.dump());
}

bool WalletStorage::add(const std::string& wallet) {
  if (!validate_public_key(wallet)) return false;

  auto wallets = get();
  if (!wallets.insert(wallet).second) return false;

  save(wallets);
  return true;
}

bool WalletStorage::remove(const std::string& wallet) {
  auto wallets = get();
  if (wallets.erase(wallet) == 0) return false;

  save(wallets);
  return true;
}

void WalletStorage::clear() { save({}); }

}  // namespace eclipse::cli
