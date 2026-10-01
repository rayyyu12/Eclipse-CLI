// The stream backend for a build configured without -DECLIPSE_COPYTRADE.
//
// Nothing here pretends to stream: available() is false, the menu says copy
// trading is not compiled in, and subscribe() fails with the same message if
// anything reaches it anyway. It exists so the rest of the copy trader links,
// and is therefore compile-checked, in the default build.

#include "eclipse/copytrade/geyser_client.hpp"

namespace eclipse::copytrade {

struct GeyserClient::Impl {};

bool GeyserClient::available() { return false; }

GeyserClient::GeyserClient(GeyserOptions) : impl_(std::make_unique<Impl>()) {}

GeyserClient::~GeyserClient() = default;

std::string GeyserClient::subscribe(const SubscriptionRequest&,
                                    const StreamHandlers&) {
  return "copy trading is not compiled into this build; configure with "
         "-DECLIPSE_COPYTRADE=ON";
}

void GeyserClient::cancel_current() {}

void GeyserClient::shutdown() {}

}  // namespace eclipse::copytrade
