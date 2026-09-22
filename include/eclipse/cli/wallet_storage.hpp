#pragma once

#include <set>
#include <string>

namespace eclipse::cli {

/// The set of wallets the copy-trade feature follows.
///
/// Kept inside the encrypted store rather than a plain file, because who a
/// user copies is itself worth keeping private.
class WalletStorage {
 public:
  static WalletStorage& instance();

  std::set<std::string> get() const;

  /// Returns false when the address is malformed or already tracked.
  bool add(const std::string& wallet);
  bool remove(const std::string& wallet);

  void clear();

 private:
  WalletStorage() = default;

  void save(const std::set<std::string>& wallets);
};

}  // namespace eclipse::cli
