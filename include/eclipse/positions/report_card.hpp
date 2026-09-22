#pragma once

#include <string>

#include "eclipse/positions/portfolio_tracker.hpp"

namespace eclipse::positions {

/// Renders a closed position as a standalone SVG card.
///
/// The TypeScript build rasterised this with node-canvas and bundled three
/// font files to do it. SVG needs neither: Discord renders it from the markup,
/// and the repository loses 400 KB of binary assets.
std::string render_position_card(const Position& position,
                                 double realized_profit_percent);

/// Posts the card to the configured Discord webhook.
///
/// The URL comes from settings. It is deliberately not compiled in: the
/// TypeScript build hardcoded a live webhook token in a public file.
/// No-op, returning false, when notifications are off or no URL is set.
bool post_position_card(const Position& position,
                        double realized_profit_percent);

}  // namespace eclipse::positions
