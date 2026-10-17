# Exact Desktop contract generation

`export_desktop_transport` compiles the host-owned Rust data declarations and
schema exporter directly, using the existing CLI package's Core, serde and
schemars dependencies. It does not link Tauri, its plugins, a WebView or the
native Desktop build script. No schemas or host types are copied into this example.

From the repository root:

```sh
cargo run --locked -p portcove-cli --example export_desktop_transport
node scripts/check-transport-contract.mts
node scripts/check-transport-contract.mts --write
node apps/desktop/scripts/generate-transport-types.mts
```

The normal checker compares compiled Rust output/input/event schemas with all
existing generated contracts and retains the exact command/event exposure checks.
On Windows it also compiles the native production exporter and requires the
complete envelopes to agree. A capable Linux/macOS host can explicitly select
that comparison with `--native-parity`; an unavailable native build fails that
request rather than becoming a headless success. `--ipc-only` remains read-only
source exposure inspection and cannot select native parity or substitute schemas.

This development example does not add a public CLI command, storage authority,
native readiness, native interaction evidence or Favorites behavior. Ordinary
Desktop workspace compilation and native owning-issue acceptance remain separate.
