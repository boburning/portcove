# Isolated role continuation preparation

This #534 implementation connects the existing actual same-process admission
callback to payload signing. It does not activate the held controller, provision
keys or clear the compiler, native, publication-history or other admission holds.
The current actual acquisition still returns HOLD, so no positive signing run is
claimed. The standalone held workflow fragment still needs the final connected
immutable output/attestation handoff and resource-policy reconciliation.

The caller first authenticates the existing fixed-source tool artifact using its
same-process receiver, including the complete tool inventory and immutable source,
run and attempt. Imported and injected-provider receipts cannot choose executable
tools. The schema-2 bootstrap inventory includes the pinned Tauri CLI 2.12.2 native
addon and package policy, so a role job needs no npm/Cargo installation or candidate
code. The actual bundled payload CLI reacquires its own tool receipt; no serialized
runtime brand is imported.

Existing admission performs package/public-input acquisition before its late
control handshake. Only its genuine zero-hold, actual-provider callback can enter
the continuation. The exact public updater key comes from the verified Windows
and Linux public-input archives; both must match each other and the independently
configured public-key digest. The complete verified aggregate, reservation and
two exact policy updater requests remain bound in the same process.

Before opening a key channel, before each actual signer invocation and before
returning completed outputs, the worker requests a new ordinal/nonce control
round. It rechecks the existing reservation and fixed tool bytes, then calls the
actual source's `read` with the private frozen opportunity. Classification,
publication pause and capacity references must still match the admitted snapshot;
publication must remain unpaused and the resource policy must match the fixed
controller. The sixty-second protection freshness window is unchanged.

The one-use Linux Unix socket transports only the selected role key to a private
callback after those checks. It uses a fresh private directory, owner/mode checks,
a random challenge, bounded exact UTF-8 fields and no key file, command argument
or public credential output. The key client is a separate fixed step in the same
isolated job; later hosted wiring must run it in the background while literal
readiness uploads proceed, and join both processes before terminal output. Its
finite transport deadline is not authority to reuse stale controls. A disconnected
client cannot cause terminal publication or cleanup before the actual consumer
callback settles. JavaScript strings are not claimed to provide secure erasure.

The actual signer copies independently pinned tools and payload bytes into owned
private home/profile/temp storage, verifies Tauri 2.12.2, signs with `--app-version`,
and authenticates bytes, size, public key and signed version through the maintained
Rust verifier. A current-control refusal occurs before reading key material. The
transport does not trust an injected signer result or caller acceptance boolean.
Only detached signatures and bounded public receipts survive private cleanup;
neither a signature nor a role identity alone grants publication.

Five TUF reader phases have separate fixed role environments and OIDC subjects.
The isolated metadata observer uses distinct phase audiences. New-release TUF
work must call `read` with the actual frozen opportunity before each role key;
only unchanged-record renewal uses `readMaintenance`. Offline Root/Targets remain
outside these online roles. Exact native/compatibility record reconstruction,
signed immutable output custody, final role wrappers and the complete one-hundred
minute hosted graph remain separate implementation work. No stronger completion
or protected execution claim follows from this checkpoint.
