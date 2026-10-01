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
#
# With -DECLIPSE_COPYTRADE=ON, also gRPC C++ and Protobuf; see below.
# ---------------------------------------------------------------------------

option(ECLIPSE_COPYTRADE
  "Build the Yellowstone gRPC stream the copy trader listens on (needs gRPC and Protobuf)"
  OFF)

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
  src/cli/handlers/copy_trade_handler.cpp
  src/cli/handlers/copy_trade_settings_handler.cpp

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

  # Copy trading. Everything here is gRPC-free and always compiled; only the
  # Yellowstone stream itself (geyser_client) depends on ECLIPSE_COPYTRADE.
  src/copytrade/types.cpp
  src/copytrade/transaction_parser.cpp
  src/copytrade/copy_trade_logger.cpp
  src/copytrade/copy_swap.cpp
  src/copytrade/copy_executor.cpp
  src/copytrade/stream_supervisor.cpp
  src/copytrade/transaction_monitor.cpp
  src/copytrade/balance_monitor.cpp
)

target_include_directories(eclipse_core PUBLIC include)

target_link_libraries(eclipse_core PUBLIC
  CURL::libcurl
  OpenSSL::Crypto
  OpenSSL::SSL
  nlohmann_json::nlohmann_json
  Threads::Threads
)

# ---------------------------------------------------------------------------
# Copy trading stream
#
#   cmake -B build -DECLIPSE_COPYTRADE=ON
#
# The copy trader follows wallets over a Yellowstone gRPC (Dragon's Mouth)
# Subscribe stream. That one translation unit, geyser_client.cpp, is the only
# code that needs gRPC; it is built from geyser.proto and solana-storage.proto,
# vendored unmodified under third_party/yellowstone-grpc-proto (Apache-2.0,
# from rpcpool/yellowstone-grpc; see the README there for the pinned commit).
#
# Needs gRPC C++ and Protobuf with protoc and grpc_cpp_plugin, found through
# their CMake packages. Off by default, in which case
# geyser_client_unavailable.cpp stands in and the menu reports that copy
# trading is not compiled in. Everything else in src/copytrade builds either
# way.
# ---------------------------------------------------------------------------

if(ECLIPSE_COPYTRADE)
  find_package(Protobuf CONFIG QUIET)
  if(NOT Protobuf_FOUND)
    find_package(Protobuf REQUIRED)
  endif()
  find_package(gRPC CONFIG REQUIRED)

  set(YELLOWSTONE_PROTO_DIR
      ${CMAKE_CURRENT_SOURCE_DIR}/third_party/yellowstone-grpc-proto)
  set(YELLOWSTONE_GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated/yellowstone)
  file(MAKE_DIRECTORY ${YELLOWSTONE_GEN_DIR})

  set(YELLOWSTONE_PROTOS
      ${YELLOWSTONE_PROTO_DIR}/geyser.proto
      ${YELLOWSTONE_PROTO_DIR}/solana-storage.proto)

  set(YELLOWSTONE_GENERATED)
  foreach(name geyser solana-storage)
    list(APPEND YELLOWSTONE_GENERATED
         ${YELLOWSTONE_GEN_DIR}/${name}.pb.cc
         ${YELLOWSTONE_GEN_DIR}/${name}.pb.h
         ${YELLOWSTONE_GEN_DIR}/${name}.grpc.pb.cc
         ${YELLOWSTONE_GEN_DIR}/${name}.grpc.pb.h)
  endforeach()

  # geyser.proto imports google/protobuf/timestamp.proto, so protoc also gets
  # Protobuf's own include directories.
  set(PROTOBUF_INCLUDES
      "$<TARGET_PROPERTY:protobuf::libprotobuf,INTERFACE_INCLUDE_DIRECTORIES>")

  add_custom_command(
    OUTPUT ${YELLOWSTONE_GENERATED}
    COMMAND protobuf::protoc
      --cpp_out=${YELLOWSTONE_GEN_DIR}
      --grpc_out=${YELLOWSTONE_GEN_DIR}
      --plugin=protoc-gen-grpc=$<TARGET_FILE:gRPC::grpc_cpp_plugin>
      -I${YELLOWSTONE_PROTO_DIR}
      "-I$<JOIN:${PROTOBUF_INCLUDES},;-I>"
      ${YELLOWSTONE_PROTOS}
    DEPENDS ${YELLOWSTONE_PROTOS}
    COMMENT "Generating Yellowstone gRPC sources"
    COMMAND_EXPAND_LISTS
    VERBATIM)

  add_library(eclipse_yellowstone_proto STATIC ${YELLOWSTONE_GENERATED})
  target_include_directories(eclipse_yellowstone_proto PUBLIC
    ${YELLOWSTONE_GEN_DIR})
  target_link_libraries(eclipse_yellowstone_proto PUBLIC
    protobuf::libprotobuf
    gRPC::grpc++)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    # Generated code is not ours to hold to -Wpedantic.
    target_compile_options(eclipse_yellowstone_proto PRIVATE -w)
  endif()

  target_sources(eclipse_core PRIVATE src/copytrade/geyser_client.cpp)
  target_link_libraries(eclipse_core PUBLIC eclipse_yellowstone_proto)
  add_dependencies(eclipse_core eclipse_yellowstone_proto)
else()
  target_sources(eclipse_core PRIVATE
    src/copytrade/geyser_client_unavailable.cpp)
endif()

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
