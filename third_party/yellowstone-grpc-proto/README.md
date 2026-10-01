# yellowstone-grpc-proto

`geyser.proto` and `solana-storage.proto` from Triton One's Yellowstone gRPC
(Dragon's Mouth), unmodified.

- Source: https://github.com/rpcpool/yellowstone-grpc, directory
  `yellowstone-grpc-proto/proto/`
- Pinned at tag `v16.0.0+solana.4.3.0`, commit
  `bfd1d7ee548081b6e36d4238d5ce8f34c94c4fb6`
- Licence: Apache License 2.0, copied alongside as `LICENSE_APACHE2`. The
  `yellowstone-grpc-proto` crate is published under Apache-2.0; the rest of
  that repository (the validator plugin) is AGPL-3.0 and none of it is
  included here.

SHA-256:

```
56244cb007a872f28e294eedba0db4ae4bcbfb401035e4fbb8ec9c347d8ee9b3  geyser.proto
e5d16ba9a9e83f6ed8c92a96b6b75dfd64c43f897b976011eb3ec5abe2f3c818  solana-storage.proto
```

Only compiled when the build is configured with `-DECLIPSE_COPYTRADE=ON`.
