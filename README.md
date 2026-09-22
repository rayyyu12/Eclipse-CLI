# Eclipse CLI

A terminal client for trading Solana memecoins, routing directly to Raydium
AMM v4 and the pump.fun bonding curve. Live position tracking with average
entry and PnL, configurable priority fees and Jito tips.

C++17, three dependencies, no SDK.

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

## Tests

```bash
./build/eclipse-tests
```

Covers the base58 codec, PDA derivation, shortvec encoding, message
compilation, keypair round-tripping, the constant-product maths and amount
parsing. 43 checks.

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
  cli/        menu, prompts, settings, encrypted credential store
```

## Configuration

Settings live in `settings.json` beside the binary. Credentials do not: the
RPC URL and private key go in `~/.eclipse-cli/credentials.enc`, encrypted with
AES-256-GCM under a key at `~/.eclipse-cli/storage.key`, both written `0600`.

That protects the key at rest against backups and casual inspection. It is not
protection against someone who already has your account.

Configure both from Settings on first run. The private key prompt does not
echo.

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
