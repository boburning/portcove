# Isolated updater payload-signing preparation

Owner: [#534](https://github.com/boburning/portcove/issues/534). This component
signs existing admitted NSIS/AppImage bytes, without rebuilding or executing them.
It grants no production signing, publication, key provisioning or acceptance.

The production preparation caller is
`scripts/release-payload-preparation.mts TRUSTED_CONFIG`. It accepts no raw
signing request or accepted-result receipt. Its bounded controller-owned JSON
contains `configuration` and `signer_identity`. Configuration selects the existing
ratified admission configuration, trusted aggregate/bundle upload identities,
independent public-key path/digest and fresh output. The CLI fixes `projectRoot`
to its own trusted checkout. It must run without payload signing variables.

The internal/disposable engine
`scripts/release-payload-signing.mts TRUSTED_CONFIG` consumes a derived request;
it is not the production admission entrypoint. Its configuration supplies
`projectRoot`, `payload`, `publicKey`, fresh `output`, `request` and `tools`.
The three fixed tools are `node`,
`tauriAddon` (the platform's native Tauri CLI addon), and `verifier` (the maintained
`portcove-release-tools` executable). Each tool has an independently pinned
absolute `path` and `sha256`. Candidate files cannot select tools or expected
facts. Trusted configuration generation and authenticated admission integration
remain necessary before activation; a request is not itself proof of admission.

The schema-1 request binds repository, source commit, version, Windows/Linux
platform, exact policy filename, package SHA256/length, decoded canonical
Minisign public-key SHA256, qualification-inventory SHA256 and numeric producer
run/attempt/job/artifact identities, reservation checkpoint and aggregate ZIP
digest. Request, producer and tool fields have exact inventories; unknown fields
refuse before effects. These are expected inputs to the internal signer. The
maintained updater identity/package policy
restricts signing to NSIS/AppImage; DEB/RPM and CLI archives cannot enter this role.

The connected preparer calls the actual existing admission collector rather than
importing a supplied result. It derives the complete selected assembly and
candidate artifact IDs from that acquisition, verifies the existing reservation
before/after using the maintained remote snapshot/association helpers, and calls
the existing uploaded-aggregate attestation verifier. It derives the numeric
assembler job from the verified predicate, qualification-inventory digest from
fresh acquired contexts, and payload bytes/hash/size/version from the complete
verified beta aggregate. The independently supplied key must match its exact
decoded public-key digest. Bounded ZIP validation rechecks every package and the
deterministic checksum manifest before materializing only the two opaque updater
packages. No candidate code executes. Retained public outputs include admission,
reservation and aggregate observations, the public key, exact payload bytes and
strict diagnostic requests. These outputs do not gain admission authority.

The current collector intentionally returns Hold with no descriptor. The caller
preserves every hold and additionally refuses an unconnected positive signing
disposition. It cannot sign, access a role key or publish. Injected collector
evidence cannot prepare a production request. Future integration must establish
fresh applicable acceptance controls after aggregate acquisition, authenticate
the fresh signer job with the fixed OIDC profile, and only then connect the
separate internal signing operation. No fabricated positive schema or caller
qualification digest bypass is provided here.

Before accessing the role key, the helper snapshots configuration, creates a
fresh private output/work directory, streams bounded inputs into exclusive files,
checks package/key/tool identities, and verifies the actual CLI version. A fixed
launcher loads only the copied native addon, avoiding npm resolution, lifecycle
scripts, candidate configuration/hooks and inherited Node options. All child
environments discard ambient GitHub/cloud/proxy and legacy signing variables.
HOME, USERPROFILE, AppData, XDG and temporary-directory variables point to fresh
owned scratch directories, so default user configuration/cache searches do not
reach the host profile. Only SystemRoot/WINDIR retain host OS locations.
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
failures do not emit secret subprocess diagnostics. Refusals retain a bounded
public failure receipt with phase, expected request, observed package/key
identities and tool digests. A structurally recognized partial public Tauri
signature is retained separately; unsafe/incomplete bytes have only their
bounded identity retained when acquired. Missing or unsafe content is not
described as absent. Private work, including all home/cache/temp contents, is
removed; no private credential state is retained. Existing output refuses.
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

The existing OIDC verifier now has a fixed `Sign admitted updater payloads`
profile under the existing production-controller workflow. Its signed check-run
claim must resolve to the exact numeric active job, rather than another job with
a matching name. This is job identity only: it does not establish protection
enforcement, package production or signing permission. No OIDC request or signing
workflow is activated by adding the profile.

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

The separate [held caller fragment](application-update-production.payload-signing.yml)
uses the existing controller job names, a literal false condition and an explicit
missing-positive-configuration refusal before checkout. It invokes only the
connected preparer, restores no candidate caches, references no secret or key
environment and has no signing/upload continuation. Its proposed OIDC permission
is inert outside `.github/workflows`; explicit owner provisioning and integration
remain required.
