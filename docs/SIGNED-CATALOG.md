# Signed catalog delivery, format 1

This optional local-first contract updates metadata for the existing V1 catalog. No publisher key, production private key, server, account, or scheduled fetch is configured by default. Local files work without a network; an explicitly requested HTTPS fetch carries no Portcove/GitHub credential and follows no redirects. The optional advisory relay and desktop self-updater are separate features.

## Publisher format

The outer JSON object has exactly `format_version: 1`, `key_id`, `payload`, and `signature`. It is at most 4 MiB, including all JSON escaping. `key_id` is the lowercase hex SHA-256 of the raw 32-byte Ed25519 public key. `signature` is the 64-byte signature in hex. `payload` is a JSON **string**; its exact UTF-8 bytes are signed, without parsing, whitespace changes, or reserialization by the verifier.

The signing message is the byte concatenation of:

1. UTF-8 `Portcove signed catalog v1` followed by one LF (`0a`);
2. the 64 ASCII characters of `key_id`, followed by one LF;
3. the exact UTF-8 bytes of `payload`.

The payload object has exactly `sequence`, `issued_at`, `expires_at`, and `catalog`. Sequence is a positive integer at most `9007199254740991`; times are integer Unix seconds. Issuance cannot be in the future, expiry must be in the future and later than issuance, and validity cannot exceed 366 days. The embedded `catalog` is the ordinary schema-1 catalog document, not a CLI response envelope. Consumers use `ed25519-dalek` strict verification and reject weak keys. See the [verifier's primary documentation](https://docs.rs/ed25519-dalek/3.0.0/ed25519_dalek/struct.VerifyingKey.html) and [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032).

All normal core catalog validation runs before admission. Source profiles, V1 membership, executable/setup/source-materialization contracts, and persistent-data ownership must match the embedded application catalog. Changes to those contracts ship in an application update. Allowed metadata includes names, descriptions, project URLs, support/channel/platform declarations, qualification metadata, release resolution, and upstream status. A signed catalog cannot bypass release SHA-256 verification or execute an arbitrary adapter.

## Producing and reviewing an envelope

With an existing publisher-controlled Ed25519 PKCS#8 PEM key, run:

```text
node scripts/sign-catalog.mjs --catalog catalog.json --key publisher-private.pem --sequence 1 --expires-at <unix-seconds> --output catalog-signed.json
```

The utility defaults issuance to the current time, accepts an explicit `--issued-at`, prints only the public key/fingerprint and output identity, and refuses to overwrite its output. It does not generate or choose a production key, upload anything, or replace core catalog validation. Private-key paths are inputs to this offline publisher utility, never Portcove runtime configuration. Publishers should validate the signed output through core before distributing it:

```text
portcove --library <isolated-review-library> --json catalog trust-key <public-key-hex> --yes
portcove --library <isolated-review-library> --json catalog update --file catalog-signed.json
portcove --library <isolated-review-library> --json catalog update --file catalog-signed.json --apply --expected-plan <plan_sha256>
portcove --library <isolated-review-library> --json doctor
```

Production users verify the public key/fingerprint through a trusted independent channel before granting trust. Key rotation requires explicitly adding the replacement key and later revoking the old one. Sequences continue increasing across keys; rotation does not reset replay protection. No production custody or infrastructure decision is implied by these examples.

## Publication and recovery

Review binds the exact envelope, delivery selection, current key set, selection revision, cached versions, and highest accepted sequence. Application rereads and revalidates, including expiry. SQLite atomically publishes the candidate, advances the replay floor, and records the completed activity. Cancellation can win before publication admission; a critical commit finishes safely. Concurrent or changed reviews cannot both publish. Failed verification or a rolled-back database transaction leaves the prior selection intact.

Each service command reads one coherent local snapshot. Later commands verify current key trust, signature, validity and catalog contracts again. If active data is bad, the previous trusted unexpired catalog is tried; otherwise the embedded catalog is used. Diagnostics report actual origin, document digest, sequence, key fingerprint, expiry and fallback reasons. Expired signatures never become an indefinite offline exception; embedded metadata remains available instead.

Explicit rollback consumes the previous selection and keeps the highest sequence. It does not retain the rejected newer catalog as the next fallback. `use-embedded` preserves trust and cache; `use-cached` revalidates the cache without admitting an external replay. Revocation immediately affects the next command, including both cached versions. Already-running commands keep their original snapshot and cannot change executable or data ownership because those contracts are frozen.

Trust and replay state belong to the local library's database. Managed moves retain it. Metadata-only export/import intentionally leaves it out, so each destination configures its own trust; old installed artifacts remain subject to the same embedded safety contracts. This protects against network/publisher-delivery tampering and replay under an intact local database. It does not protect against a local attacker rewriting that database, restore its newer replay floor after a whole-database rollback, or supply a trustworthy system clock.


Bundled-runtime updates may change their pinned archive asset and archive root, like a game release update. They cannot add or remove a runtime platform, change its mount directory or executable, or make runtime files mutable. Runtime-only updates receive a distinct immutable install identity. Adding a new runtime execution contract requires an application update; an older cached catalog that omits the new contract is rejected and falls back through the normal verified selection rules.
