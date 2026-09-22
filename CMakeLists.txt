cmake_minimum_required(VERSION 3.16)
project(eclipse-cli VERSION 2.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O2")
set(CMAKE_CXX_FLAGS_DEBUG "-O0 -g")

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter)
endif()

# ---------------------------------------------------------------------------
# Dependencies
#
#   libcurl   HTTP transport for the JSON-RPC client, Jito block engine and
#             the Discord webhook.
#   OpenSSL   AES-256-GCM for the credential store, SHA-256 for PDA
#             derivation, Ed25519 for transaction signing.
#   nlohmann  JSON parse/serialise. Fetched if not installed system-wide.
# ---------------------------------------------------------------------------

find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

find_package(nlohmann_json 3.9 QUIET)
if(NOT nlohmann_json_FOUND)
  include(FetchContent)
  FetchContent_Declare(nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3)
  FetchContent_MakeAvailable(nlohmann_json)
endif()

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

# Everything except main.cpp, so the test binary can link the same objects.
add_library(eclipse_core STATIC
  src/common/base58.cpp
  src/common/pubkey.cpp
  src/common/keypair.cpp
  src/common/logger.cpp

  src/net/http_client.cpp
  src/net/rpc_client.cpp
  src/net/connection_pool.cpp

  src/solana/instruction.cpp
  src/solana/transaction.cpp
  src/solana/programs.cpp

  src/cli/ansi.cpp
  src/cli/formatting.cpp
  src/cli/menu.cpp
  src/cli/validation.cpp
  src/cli/settings_manager.cpp
  src/cli/secure_storage.cpp
  src/cli/credentials_manager.cpp
  src/cli/wallet_storage.cpp
  src/cli/handlers/buy_handler.cpp
  src/cli/handlers/sell_handler.cpp
  src/cli/handlers/positions_handler.cpp
  src/cli/handlers/settings_handler.cpp

  src/swaps/blockhash_manager.cpp
  src/swaps/swap_builder.cpp
  src/swaps/regular_swap.cpp
  src/swaps/pump_swap.cpp

  src/fees/jito.cpp
  src/fees/priority_fees.cpp

  src/pools/pool_parser.cpp
  src/pools/pool_discovery.cpp
  src/pools/pool_selector.cpp
  src/pools/persistent_pool_cache.cpp
  src/pools/token_type_cache.cpp

  src/positions/portfolio_tracker.cpp
  src/positions/token_tracker.cpp
  src/positions/token_balance_monitor.cpp
  src/positions/report_card.cpp

  src/orders/order_manager.cpp
)

target_include_directories(eclipse_core PUBLIC include)

target_link_libraries(eclipse_core PUBLIC
  CURL::libcurl
  OpenSSL::Crypto
  OpenSSL::SSL
  nlohmann_json::nlohmann_json
  Threads::Threads
)

add_executable(eclipse src/main.cpp)
target_link_libraries(eclipse PRIVATE eclipse_core)

# ---------------------------------------------------------------------------
# Tests
#
#   cmake -B build && cmake --build build && ./build/eclipse-tests
#
# Covers base58, PDA derivation, message serialisation and the AMM maths:
# the places where an error is silent rather than loud.
# ---------------------------------------------------------------------------

add_executable(eclipse-tests tests/test_eclipse.cpp)
target_link_libraries(eclipse-tests PRIVATE eclipse_core)

enable_testing()
add_test(NAME eclipse-tests COMMAND eclipse-tests)

install(TARGETS eclipse RUNTIME DESTINATION bin)
