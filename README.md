# Eclipse CLI

A terminal client for trading Solana memecoins, routing directly to Raydium
AMM v4 and the pump.fun bonding curve. Live position tracking with average
entry and PnL, configurable priority fees and Jito tips, and a copy trader
that follows other wallets over a Yellowstone gRPC stream.

C++17, three dependencies, no SDK. The copy trader's stream adds gRPC as an
optional fourth.

## Why it has no SDK

The transaction layer is built from the wire format rather than a client
library: base58, ed25519 signing, program-derived addresses, shortvec length
prefixes, and legacy message compilation are all in `src/common` and
`src/solana`. That is roughly 600 lines, and in exchange the binary has no
dependency that can break on a version bump, and nothing between the code and
the bytes that reach the validator.

The pieces where a silent mistake would be expensive are pinned to known
values in the test suite. Program-derived address generation, for instance, is
checked against Raydium's published AMM authority
(`5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`), which only derives correctly
if the SHA-256 seeding, the bump search and the ed25519 on-curve rejection are
all right.

## Copy trading

The copy trader follows any number of wallets and repeats their pump.fun and
Raydium trades from your wallet, sized either at a fixed amount or mirroring
what they spent. It is a C++ port of the TypeScript copy trader from the
earlier build of this project (January 2025), and keeps that build's
latency-first design:

- **Detection.** One Yellowstone gRPC `Subscribe` stream at `processed`
  commitment, the earliest point a transaction is visible. The server filters:
  one named transactions filter per followed wallet, each requiring that
  wallet and including the pump.fun or Raydium AMM program, with votes and
  failed transactions excluded. (One filter per wallet because
  `account_required` means *all* of the listed accounts; a single filter
  naming every wallet matches nothing once there are two.) The client then
  checks that the fee payer is a followed wallet and not your own, and drops
  repeats by signature.
- **Decoding without round trips.** The venue comes from the program logs
  (`Program 6EF8...`, `ray_log:`), the amounts from the balance deltas in the
  transaction meta, and for Raydium the whole pool and OpenBook account set
  from the followed swap instruction itself, so there is no pool discovery,
  market fetch or reserve read. The minimum output is computed from the pool
  balances in that same meta.
- **Building and sending.** The blockhash is the background-refreshed cached
  one, token accounts are created idempotently rather than probed, and the
  priority fee is the configured fixed fee (no estimate call). A Raydium
  copy makes no round trip before sending; a pump.fun copy makes one, to read
  the bonding curve (plus a balance read for a sell with no tracked
  position). With automatic Jito tips on, the tip floor is fetched at most
  every 30 seconds. The transaction carries the tip and goes straight to the
  block engine with preflight skipped; its signature is taken from the
  signed bytes.
- **Never blocking the stream.** Decoding happens on the stream thread;
  execution is handed to long-lived send workers, whose HTTP connections to
  the RPC and Jito stay warm between trades, and confirmation is polled on a
  separate pool so a copy waiting to land never delays the next one. The
  wallet key is decrypted once when monitoring starts, not per trade.
- **Timing.** Every copy logs its stages as it goes: dispatch (stream to
  worker), ATA derivation, bonding curve fetch, blockhash fetch, Jito tip,
  instruction building, transaction build/sign, send, then confirmation and
  the total. Copy Trade > View Logs shows them live.

The stream is reconnected when it ends (five attempts, then it gives up) and
when nothing has arrived for a minute. Leaving the copy trade screen stops
following. pump.fun and Raydium have both changed since this was written;
treat it as a reference implementation rather than something to point at
mainnet unattended.

## Building

Needs CMake 3.16+, a C++17 compiler, libcurl and OpenSSL 3.
nlohmann/json is fetched automatically if it is not installed.

```bash
cmake -B build
cmake --build build
./build/eclipse
```

On macOS:

```bash
brew install cmake openssl@3 curl
```

The copy trader's stream is behind an option, off by default:

```bash
cmake -B build -DECLIPSE_COPYTRADE=ON
cmake --build build
```

That needs gRPC C++ and Protobuf, including `protoc` and `grpc_cpp_plugin`,
found through their CMake packages (`brew install grpc` on macOS, the
`grpc` vcpkg port elsewhere). The Yellowstone protos it compiles are vendored
in `third_party/yellowstone-grpc-proto`, Apache-2.0, pinned to a stated
commit. Without the option everything else still builds, including the copy
trader's decoding, swap building, settings and log; the menu says copy
trading is not compiled in.

## Tests

```bash
./build/eclipse-tests
```

Covers the base58 codec, PDA derivation, shortvec encoding, message
compilation, keypair round-tripping, the constant-product maths and amount
parsing, plus the copy trader: the per-wallet stream filters, pump.fun and
Raydium decoding of synthetic streamed transactions, the pump.fun instruction
layouts, buy sizing and settings validation. 87 checks, none of which touch
the network.

## Layout

```
include/eclipse/
  common/     base58, ed25519 keypairs, public keys, logging
  solana/     instructions, legacy transactions, program helpers
  net/        HTTP transport, JSON-RPC client, connection pool
  pools/      Raydium pool decoding, discovery, quoting, caches
  swaps/      Raydium and pump.fun execution paths
  fees/       Jito tips, priority fee estimation
  positions/  portfolio polling, trade history, position cards
  orders/     client-side stop-loss and take-profit
  copytrade/  Yellowstone stream, transaction decoding, copy execution
  cli/        menu, prompts, settings, encrypted credential store

third_party/
  yellowstone-grpc-proto/  geyser.proto, solana-storage.proto (Apache-2.0)
```

In `src/copytrade`, only `geyser_client.cpp` uses gRPC; it is the one file
the build option swaps for `geyser_client_unavailable.cpp`.

## Configuration

Settings live in `settings.json` beside the binary. Credentials do not: the
RPC URL and private key go in `~/.eclipse-cli/credentials.enc`, encrypted with
AES-256-GCM under a key at `~/.eclipse-cli/storage.key`, both written `0600`.

That protects the key at rest against backups and casual inspection. It is not
protection against someone who already has your account.

Configure both from Settings on first run. The private key prompt does not
echo.

The copy trader's gRPC URL and x-token live in the same encrypted store, as
does the list of wallets it follows: who you copy is worth keeping private.
Its trading settings (buy mode, fixed amount, minimum and maximum, per-venue
slippage and on/off switches) are the `copyTrade` section of `settings.json`,
editable from Copy Trade > Copy Trade Settings. The x-token is never logged.

## Notes

- Pump.fun tokens graduate to Raydium, so the venue is resolved per order
  rather than assumed. Results are cached for an hour, because a stale answer
  routes an order to the wrong program.
- Pool discovery is a `getProgramAccounts` scan that some providers rate-limit
  hard. Resolved pools are cached to `pools-cache.json` indefinitely, since a
  pool's account set never changes once created.
- Buying wraps SOL in a throwaway account created and closed inside the same
  transaction, so a failed swap cannot strand wrapped SOL.
- The Discord webhook URL is read from settings and is off by default.
  Notifications render as SVG, which needs no font files or rasteriser.
- A 429 from an RPC endpoint is treated as backpressure, not an error. The
  connection pool parks an endpoint after three consecutive failures and
  revives the last working one if every endpoint goes down.

## Licence

MIT.
