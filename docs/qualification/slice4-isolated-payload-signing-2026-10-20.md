# Isolated updater payload-signing preparation

Owner: [#534](https://github.com/boburning/portcove/issues/534). This component
signs existing admitted NSIS/AppImage bytes, without rebuilding or executing them.
It grants no production signing, publication, key provisioning or acceptance.

The trusted controller calls `scripts/release-payload-signing.mts TRUSTED_CONFIG`.
The bounded controller-owned JSON supplies `projectRoot`, `payload`, `publicKey`,
fresh `output`, `request`, and `tools`. The three fixed tools are `node`,
`tauriAddon` (the platform's native Tauri CLI addon), and `verifier` (the maintained
`portcove-release-tools` executable). Each tool has an independently pinned
absolute `path` and `sha256`. Candidate files cannot select tools or expected
facts. Trusted configuration generation and authenticated admission integration
remain necessary before activation; a request is not itself proof of admission.

The schema-1 request binds repository, source commit, version, Windows/Linux
platform, exact policy filename, package SHA256/length, decoded canonical
Minisign public-key SHA256, qualification-inventory SHA256 and numeric producer
run/attempt/job/artifact identities. These are expected inputs, not facts derived
or authenticated by this signer. The maintained updater identity/package policy
restricts signing to NSIS/AppImage; DEB/RPM and CLI archives cannot enter this role.

Before accessing the role key, the helper snapshots configuration, creates a
fresh private output/work directory, streams bounded inputs into exclusive files,
checks package/key/tool identities, and verifies the actual CLI version. A fixed
launcher loads only the copied native addon, avoiding npm resolution, lifecycle
scripts, candidate configuration/hooks and inherited Node options. All child
environments discard ambient GitHub/cloud/proxy and legacy signing variables.
Only the signer child receives `TAURI_SIGNING_PRIVATE_KEY` and its password; the
independent Rust verifier receives neither. No TUF key is consumed.

Tauri CLI [2.12.2 signer source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/src/signer/sign.rs)
and actual pinned help confirm `--app-version`. Its
[signature implementation](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/src/helpers/updater_signature.rs)
binds filename/version in the authenticated trusted comment. The existing Rust
payload verifier authenticates the signature, public key and exact hash/length;
the helper additionally requires that authenticated comment's exact version and
filename. The [build interface](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/src/build.rs)
supports `--no-sign` for secret-free builders. This helper never invokes build.

Success exposes only `<package>.sig` and the CLI's public
`payload-signing-receipt.json`. The receipt associates expected producer and
qualification identities with signature identity; it is not a signed producer
attestation or qualification grant. Private work is removed on success/failure;
failures do not emit secret subprocess diagnostics. Existing output refuses.
The package and tools are never uploaded from this role. Successful integration
must upload the signature/receipt as a separate immutable attempt-specific
artifact with overwrite disabled and seven-day retention, independently bind
its numeric artifact identity, and reverify it before updater inventory/feed
assembly. Those workflow/consumer links remain pending.

The disposable fixture exercises actual Tauri CLI 2.12.2 and the maintained Rust
verifier over inert binary bytes, changed bytes even with recomputed SHA256,
wrong signed version, wrong tool pin, stale output and input refusals. It deletes
the disposable private file and removes signing variables before consumer
verification. This is cryptographic fixture evidence, not NSIS installation,
AppImage startup, production custody or qualification. Ordinary tests skip the
real fixture when the installed addon/verifier are unavailable; the existing
updater-artifact rehearsal builds the verifier before running it. Local explicit
fixture paths use `PORTCOVE_TEST_TAURI_ADDON` and
`PORTCOVE_TEST_PAYLOAD_VERIFIER`; they are not production tool authority.

## Held integration boundary

No runnable secret job is added. The future existing protected controller job
must remain held until its exact grant/configuration and independently admitted
inputs exist. Its fixed steps are: checkout the pinned trusted controller only;
provision independently pinned tools without candidate caches/hooks; acquire
opaque admitted payload plus independently trusted public key; materialize the
trusted configuration; invoke the fixed signer with only the payload role key;
upload only the detached signature/public receipt using immutable run/attempt
names. It must not check out candidate code, run package-manager/build commands
with the key, expose TUF keys, or publish. The isolated attester and independent
consumer remain separate existing boundaries. No production role or environment
is selected by this preparation document.
