# Application update trust and recovery design

This contract implements the design scope of #223 under [Delivery](DELIVERY.md).
It does not activate an updater or authorize production custody, signing or
publication. Executable fixtures use fresh disposable keys and temporary local
repositories. Installed-package and physical-platform qualification remain
distinct from this design evidence.

## Owners and independent trust claims

The Tauri host owns application preferences, install ownership, trusted metadata,
staging, replacement and its recovery journal. Core owns library schemas,
migrations, game sessions, mutation locks and all game data. React presents typed
host results; it supplies neither trusted URLs nor keys. Desktop never silently
replaces a separately installed CLI. Catalog keys cannot authorize application code.

The host persists one strict application-update choice containing the Stable or
Preview channel, automatic, notification-only or manual mode, and a pause flag.
This state lives beside host configuration and outside all libraries and payload
staging. A missing document means consent has not been recorded and remains
read-only. Saves use compare-and-swap revisions under path-keyed process and OS
locks, then atomically publish flushed bytes. Unknown fields, malformed state and
future schemas fail closed; explicit reset clears consent while advancing the
revision. The typed get, save and reset commands perform no update check, download,
staging or application side effect.

Desktop Settings presents that state as a local draft with the installed application
version, channel, mode and pause control. A missing choice stays nonconsenting even
while the recommended Preview/automatic draft is visible. Only the explicit Save
action persists it; discarding changes has no host side effect, and reset returns to
the missing-choice state. The Stable explanation promises only a newer eligible
production release and never a downgrade. Automatic-mode disclosure names staging
and makes safe exit or an explicit Restart to update action a separate apply boundary.

The same Settings card reads a sanitized host status containing only check cadence,
the verified staged version/channel/size, a pending safe-exit or restart request, and
named recovery requirements. It does not receive repository URLs, signatures, keys,
payload paths, installation paths, library roots or raw storage errors. Corrupt
schedule, staging and apply journals remain separate visible recovery states. An
explicit repair command locks and rechecks the selected fixed journal before clearing
it, so a stale renderer cannot erase state that another process already repaired.
Preference corruption has its own explicit reset and returns to no consent.

The separate host schedule records successful-check cadence and bounded retry state,
not a device identity or updater operation. A pure decision delays automatic work
for 30 seconds after startup, at least 24 hours after success, and 15 minutes through
at most six hours after failure with bounded jitter. Automatic checks require a
recorded nonmanual, unpaused choice and unmetered connectivity. Each outcome binds
the preference revision observed by its check, so a later channel or mode change
ignores stale cadence. Unknown metering holds for an explicit manual choice. Manual
checks bypass local cadence and policy
holds but still refuse known offline state. The strict bounded document uses
compare-and-swap revisions, path-keyed process and OS locks, durable atomic writes,
and explicit reset for malformed or future state. No decision performs network,
download, staging or application work.

One host coordinator serializes due and manual checks across processes, re-evaluates
policy after taking ownership, and awaits the injected authenticated repository
checker off the startup path. Completion records success or bounded failure backoff
against the schedule revision that admitted the check, so a concurrent explicit
reset wins. Cancellation releases ownership without manufacturing an outcome. An
observed preference change returns only a superseded result. A candidate result
carries the preference revision that staging and apply work must revalidate. The
coordinator classifies transport failures as unreachable, expired/replayed metadata
and clock regression as stale, and all other rejected metadata separately. The
original error remains available for host diagnostics, but no failed check returns a
candidate. An injected completion can retain that same cross-process owner through a
selected follow-on step. Its failure records bounded retry instead of the daily
success interval; success is recorded only after completion. The coordinator adds no
URL, key, network, staging or apply authority of its own.

The host `application_update_operation` boundary composes that coordinator with
authenticated payload acquisition and the verified staging store. Automatic mode
stages only a newer authenticated candidate with its matching authenticated payload
key; notify-only and manual modes return the sanitized candidate status without
opening a payload. An exact already-verified staging identity is reused without a
second download. Fixed checking, acquiring-and-verifying, staged and complete
phases reveal no URL, signature, key or path. Cooperative cancellation before or
during network/staging work publishes no unverified bytes, and the staging journal
restores the prior verified slot on restart. This operation is dependency-injected
and has no registered command, production metadata origin, exit hook or platform
replacement authority.

Core supplies a pre-apply quiescence guard under the current library's exclusive
lifetime lease. Every open CLI or Desktop library already holds the shared side, so
another process or dispatched operation blocks admission without a new daemon. Once
exclusive, core rejects a relocated source root, an old schema, any unfinished launch
session and any running activity until recovery. The host retains the guard while
performing its checks and replacement, closing the race with a newly opened library.
This proof is limited to current-library quiescence; it grants no candidate freshness,
executable ownership, permission, consent or replacement authority.
Every normal CLI operation, Desktop process, launch supervisor and recovery helper
also holds a user-scoped shared application-runtime lock. Apply admission acquires its
exclusive side before the current-library guard, excluding a process that selected a
different library and preventing a new process from entering during replacement. This
coordination has no daemon, library inventory or durable updater authority.
A dedicated post-exit helper sequence accepts only the expected apply-journal
revision. It uses that persistent runtime lock, rather than a parent PID, to wait a
bounded two minutes for all Portcove processes to release their shared lifetime
proof. This survives a parent that exits before the helper is scheduled and covers a
CLI or Desktop process using another library. The helper then obtains a newly
observed installed context and fresh authenticated candidate through a host-owned
Rust provider and acquires the existing apply/runtime/library lease in its canonical
order. The retained and newly observed contexts must match. A concurrent new process
makes the final admission fail closed. The sequence has no registered command-line mode or
production root, origin, key or native-launch authority.

| Claim                           | Mechanism                                                        | Limit                                                                       |
| ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Payload authenticity            | Mandatory maintained Tauri updater signature                     | Does not authenticate feed JSON or current eligibility                      |
| Exact bytes                     | Authenticated SHA-256 and length reconciled with final inventory | Adjacent unsigned checksums alone give no publisher authority               |
| Release and promotion authority | TUF authenticated metadata and targets with separate roles       | Does not bypass compatibility or safe-apply checks                          |
| OS publisher identity           | Authenticode or Developer ID if separately provisioned           | Ad-hoc signing has limited identity; signatures do not guarantee no prompts |
| OS enforcement                  | Actual ownership/permissions, Defender and Gatekeeper            | Passive installation is not a bypass                                        |

Select TUF 1.x with maintained Rust `tough`; the fixtures lock version 0.24.0.
Its editor and client own canonicalization, signing and verification, with no
Portcove crypto implementation. Select `tauri-plugin-updater` 2.11.0 or a later
reviewed compatible version for payload verification and native replacement.
Its source uses `minisign-verify`. The plugin is not installed by this design.
Recheck current versions/advisories at integration; pins may change with validation.

## Metadata and promotion

Ship an application-specific trusted TUF root inside the installed package. The
offline root role uses three distinct keys with a two-signature quorum. An offline
top-level targets role delegates bounded paths to distinct online release, Preview
and Stable roles. Timestamp and snapshot use separate online keys. Use consistent
snapshots in production. Preserve this separation in credentials/job permissions,
not just public key names. No catalog key participates in these roles.

The release role controls immutable `releases/<version>/<target>/<package>.json`
records binding schema, SemVer, commit/tree, qualified workflow/run/attempt,
OS/architecture/execution context, package identity, immutable asset URL, SHA-256,
length, Tauri signature and payload key ID. Include minimum OS, host capabilities,
CLI protocol, catalog formats and library compatibility, plus exact evidence IDs.

Channel roles separately control versioned
`channels/<channel>/<target>/<package>/<version>.json` records, binding the
path/digest of an authenticated release record, explicit eligibility or withdrawal,
a bounded reason and any required bridge. Retaining applicable versioned promotions
lets the host choose the highest compatible version instead of losing a qualified
fallback when a newer release raises an OS or schema requirement. Preview cannot
promote Stable; promotion cannot alter release bytes, compatibility or signer keys.
Require both authorities in one coherent verified snapshot. Stable eligibility
requires the separately authorized production policy; all public 0.x is Preview.
Promoting identical installed bytes never causes reinstallation. GitHub latest,
release date and absence of a suffix are not eligibility authority.

The offline `reconstruct-application-update-records.mjs` tool consumes the raw
verified #219 inventory manifests and their exact signature files, frozen source
tree and qualified-run identity, compatibility contract, evidence IDs and the
separate reviewed eligibility map. It computes each inventory digest itself and
deterministically emits the release records, versioned Preview/Stable promotions
and a content-addressed reconstruction manifest. Exact retries are no-ops. A
partial channel tree is atomically reconstructed, while an existing immutable
release record cannot be changed or omitted.

The offline `portcove-release-tools build-tuf` operation consumes that exact
reconstruction manifest plus the separately reviewed payload-key registry. It
uses maintained `tough` to bind every listed record into direct release, Preview,
and Stable delegated roles, signs top-level targets, snapshot, and timestamp with
three other distinct externally supplied keys, and writes consistent-snapshot
hash-prefixed target bytes into one staged repository bundle. The supplied signed
root must already authorize the three top-level keys. Role versions, a near-current
generation time, and expiry windows are explicit inputs; timestamp is capped at 48
hours, snapshot/channel at seven days, and targets/release at 90 days. An exact
retry verifies the existing signatures, versions, expiry values, target inventory,
and content manifest; changed immutable output is refused.

Neither offline operation provisions or retains private keys, authenticates its
controller inputs, publishes to GitHub Pages, configures an endpoint, downloads,
or activates the runtime updater. The protected controller must verify inventories
immediately before reconstruction, supply the independently controlled role
credentials, and publish the resulting immutable bundle without running candidate
code.

The offline targets authority also controls a payload-key registry. An ordinary
release or promotion signer cannot add an executable key. The host selects the
exact registered key from authenticated metadata and passes it to Tauri's verifier.
Never accept a key from arbitrary feed JSON. Legacy single-key clients need an
old-key-signed compatible bridge while that key is trustworthy, or an independently
verified manual bootstrap. The plugin alone does not implement TUF or key rotation.

Registry format 1 is the strict `keys/payload.json` top-level target with only
`schema_version` and `keys`. It carries at most 16 entries containing the lowercase
SHA-256 identity and Tauri's base64 encoding of the exact minisign public-key file.
The host decodes and parses every entry with the same minisign implementation used
by Tauri, recomputes the identity over the decoded bytes, rejects duplicates and
unknown fields, and returns only the key named by the selected release. Removing a
key from a newer authenticated registry revokes it for later selection; update apply
must recheck fresh trust instead of retaining registry bytes as independent authority.

Keep immutable release records after withdrawal for diagnosis. Increasing channel
metadata excludes withdrawn versions from staging/application and normally offers
a newer forward repair. Withdrawal neither deletes user data nor terminates an
already installed offline application.

The Tauri host's `application_update` module now owns the strict schema and
selection boundary after TUF verification. It accepts only fully consumed release
and channel target bytes, verifies that the promotion binds the exact release path
and SHA-256, retains the qualified workflow revision/run and inventory digest,
matches installed target/package/owner/execution and compatibility context, and
selects by maintained SemVer precedence. Its typed result distinguishes
an available update, an identical current version, a held older or withdrawn
candidate, incompatibility and no candidate.

The sibling `application_update_repository` bridge discovers only versioned
promotions in the installed channel/target/package namespace and requires the
promotion and release records to be directly owned by separate top-level delegated
roles. It rejects direct top-level records, duplicate target paths, malformed or
unbounded indexes and missing referenced releases. It fully consumes each
authenticated stream under per-record and aggregate byte limits before handing
the borrowed bytes to the selector. When that selector returns a candidate, the
bridge requires the exact payload key from the offline-authorized top-level registry
and returns its Tauri encoding beside the selection. A release or channel role
cannot supply or override that key.

The sibling `application_update_payload` boundary accepts an already obtained
payload stream, the selected release artifact identity and that exact registry key.
It independently revalidates the key's decoded-byte identity, requires a modern
prehashed Minisign signature, and streams the payload once through the authenticated
length, 2 GiB host cap, SHA-256 and signature checks. It returns a Rust-only verified
identity only after all checks succeed. The boundary does not choose a URL, download,
stage or replace an application, and its result supplies no fresh-eligibility or
installation authority.

The host's `application_update_staging` boundary copies that same stream into one
fixed private incoming slot while verification runs. Before writing it requires
free capacity for the authenticated payload plus an equally sized native replacement
workspace; an already retained prior payload is accounted for by the filesystem's
used space. Its strict bounded journal advances through staged, payload-verified and
verified phases under path-keyed process and OS locks. A failed verification removes
the incoming bytes and restores the prior verified candidate. Restart reconciliation
only publishes from the durable payload-verified phase, so equal payload bytes in two
release records cannot make an unfinished signature check appear complete. Unknown,
future or inconsistent journals fail closed until explicit reset, which removes only
the fixed staging files. Reconciliation identifies locally retained bytes; it grants
no fresh trust, eligibility or apply authority. No production downloader or platform
replacement is activated by this slice.

The sibling `application_update_apply` boundary records an immutable pending intent
for either safe normal exit or an explicit one-restart action. The strict bounded
journal binds the selected candidate to the observed preference revision and choice,
installed application context, and canonical current-library root under process and
OS locks. Only Portcove-owned application installations are admitted. Compare-and-
swap revisions stop stale exit observers, a different candidate cannot overwrite a
pending intent, and explicit recovery clears only this journal. Normal Exit matches
safe exit and Restart to apply matches the explicit action. Crash, OS shutdown,
Steam Stop, missing hooks and every mismatched observation remain held on restart.
A matching record permits only a fresh revalidation attempt; it does not establish
current metadata, eligibility, consent, staged bytes, ownership, permissions,
quiescence or native replacement authority. Admission closes that race by retaining
the apply-journal, preference, staging, user-scoped application-runtime and
current-library locks in that fixed order while it verifies the expected revision and
termination, unchanged choice, exact staged and freshly authenticated candidate,
exact installed context, current compatibility and library quiescence. The resulting
lease still grants no executable ownership or replacement permission. The Windows
adapter durably records `starting` before native process creation, `started` after a
child is created, and `failed` only when no child was created. Automatic revalidation
stays closed after every launch attempt. An explicit retry can reopen only `failed`;
ambiguous `starting` and `started` require reconciliation against newly observed
installed identity. No production exit hook activates this sequence.

The sibling `application_update_trust` module owns the durable host trust boundary.
Under path-keyed process ownership and one OS file lock it supplies `tough` with the
latest persisted root, safe expiration enforcement and bounded
root/timestamp/snapshot/targets sizes. A small atomically replaced state file retains
each canonical signed role body's hash and version plus the greatest accepted
wall-clock time outside payloads and game libraries. Signature bytes are excluded,
so a valid re-signing of unchanged metadata does not create false equivocation.
Time advances before remote metadata is read, role floors never fall, and a verified
root transition remains trusted even when later metadata fails.
Clock regression, missing/corrupt state and concurrent ownership fail closed. The
loader accepts disposable local `file:` repositories for tests and host-selected
HTTPS bases for production metadata. The HTTPS transport resolves each domain once
under the shared deadline, rejects any non-public result, pins the accepted address
set into a no-proxy client, refuses redirects and limits requests, idle time,
per-role bytes and aggregate metadata bytes while streaming. Metadata and target
record bases must use separate path prefixes on port 443. The request boundary is
Rust-only and cannot be populated from frontend IPC. No production origin is
configured and no updater check is activated by this transport slice.

The sibling `application_update_download` boundary accepts only an authenticated,
selected candidate. It requires the exact Portcove `github.com` repository and
release-version path, then manually follows at most five redirects through
`release-assets.githubusercontent.com` release-asset identities. Each request uses
anonymous, no-proxy HTTPS with public DNS results pinned into the client; credentials,
referrers, encoded responses, unexpected content lengths, loops, unapproved hosts and
special-use destinations fail closed. Connection and idle timeouts sit inside a
30-minute total deadline, and the returned reader cannot exceed the authenticated
payload length. The staging verifier still establishes length, SHA-256 and Minisign
identity before retaining bytes. This boundary configures no production metadata
origin or update check and grants no staging, apply, signing, publication or native
replacement authority.

## Freshness, replay and bounds

Use safe expiration enforcement. Under one host OS lock, persist the latest verified
root and timestamp/snapshot/targets replay state outside payloads and libraries.
Pass the latest trusted root on subsequent loads: a datastore alone must not be
assumed to select a newer root automatically. Persist root progression before using
new authority. Preserve version floors across failed checks, channel changes and
binary recovery. An interrupted update needs a fresh retry, not a replay reset.
Deleting trust state is an explicit bootstrap/recovery trust operation.

Maximum expiry windows are 48 hours for timestamp, seven days for snapshot/channel,
90 days for release metadata and one year for root/delegation. Renew metadata
independently of application releases without rewriting immutable application bytes.
Check normally at most daily after a successful automatic check, and require fresh
verification immediately before apply. Offline, expired, withdrawn and rate-limited
candidates are held; local application use continues. Offline clients cannot learn
immediate revocation. Freeze detection depends on trustworthy time and retained
state: persist the greatest accepted time, detect clock regression and report a
clock problem instead of disabling expiry. Administrator/host compromise is outside
metadata attack resistance.

The host enforces transport and authenticated-structure caps in addition to library
limits: 256 KiB/root, 32 KiB/timestamp, 1 MiB/snapshot or targets role,
256 KiB/release or channel record, 8 MiB total metadata, 32 sequential root
transitions, 16 globally unique delegated roles with depth two, 1,024 total target
records, 1,024 delegation selectors, 128-byte role names, and 512-byte target paths
or path patterns. Missing delegated metadata and malformed hash-prefix selectors fail
closed. Reject unsupported record schemas and duplicate contract fields. `tough`'s
`max_targets_size` is insufficient alone because signed declared lengths can override
it. Absolute streaming caps must still apply. Stage one candidate
and its immediately previous recovery payload, each at most 2 GiB, and check disk
space for download, native replacement and recovery before beginning. Change a cap
deliberately if a legitimate package exceeds it.

Pin HTTPS metadata origins and path prefixes in trusted host configuration; reject
metadata redirects. Payload URLs must identify immutable GitHub release assets from
authenticated records. Permit at most five redirects to the exact reviewed GitHub
asset-host allowlist, HTTPS port 443, without userinfo, credentials or authorization
headers. Reject local/file URLs, private destinations, unapproved hosts and loops
in production. Bound DNS, connect and idle time; metadata has a 120-second deadline.
New production origins require a reviewed trusted configuration change. Local file
transport belongs only to tests.

Consume target streams fully before parsing or acting: early bytes are not verified.
The host's streaming payload boundary verifies final length, SHA-256 and Tauri
signature together before any later staging or application step can accept its
verified identity. Use the
maintained native installer/replacement route with explicit archive entry, expanded
size and path/link limits; no arbitrary ZIP overwrite. Extraction grants no execution
authority. Each platform must prove interruption and extraction bounds before use.

## Key lifecycle

Production keys are generated only during separately authorized provisioning. Keep
offline keys and recovery copies in independently controlled storage with public
fingerprints, custody inventory and tested restoration. No private key goes into
Git, logs, releases or ordinary CI. Fixtures generate temporary disposable secrets.

| Event                               | Required recovery                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planned root rotation               | Every sequential bridge meets both old and new quorums; retain endpoints/bridges for supported skipped clients.                                                |
| One offline key lost or compromised | The remaining two uncompromised keys replace it; one key cannot appoint a new root.                                                                            |
| Online key lost                     | Its offline authority replaces it; reconstruct metadata from immutable identities and authenticated eligibility.                                               |
| Online key compromised              | Stop the signer, rotate authority, withdraw affected candidates, refresh metadata and forward repair; assess other exposed roles.                              |
| Payload key lost                    | Use a preprovisioned offline-authorized replacement and compatible host; legacy single-key clients need a prepared bridge or independently verified bootstrap. |
| Payload key compromised             | Revoke new use and staged intent, rotate through independent metadata authority and forward repair. A compromised sole key is insufficient recovery authority. |
| Root quorum lost or compromised     | In-band recovery is unavailable or untrustworthy; use a separately authenticated manual bootstrap with independently checked package/key identity.             |

A new root's self-signature does not establish continuity. Expired old roots may
participate in TUF's sequential update, but final metadata/root must be fresh. A
missing bridge or exhausted transition bound needs verified bootstrap. Never trust
a later root merely because old keys are unavailable. Retain bridge artifacts and
metadata for the declared client support window; no procedure magically recovers
a sole lost secret without prior independent preparation.

## Trusted signing boundary

Production authority is a fixed trusted workflow/revision and protected environment,
separate from candidate commits. Inputs bind exact eligible commit/tree, reviewed
classification, trusted workflow ID, run ID/attempt, complete inventory, required
checks/review and applicable qualification. Recheck repository identity, current
eligibility, check conclusions and artifact hashes at signing; a candidate cannot
assert its own passing gates.

Build/test without production credentials. The signer receives inventory as inert
bytes, verifies hashes/sizes with trusted tools and signs exact final distributed
bytes. It never checks out or executes candidate scripts, binaries, local actions,
package hooks or instructions with secrets. Native byte-changing steps precede final
hashes and updater signatures. Provisioned native signing uses similarly trusted
tools. Separate least-privilege signing, publication and promotion identities,
serialize publication, make retries bind identical inputs and independently read
back immutable assets/metadata.

Current protected release gates remain effective. Candidate code cannot approve
its own signer, secret access, production eligibility or bypass. Provisioning needs
the concrete reviewed implementation, public fingerprints, custody/recovery rehearsal
and refusal tests. Test keys provide no production authorization.

## Ownership and compatibility

Each install has one owner: Portcove for a qualified user-owned NSIS/AppImage/macOS
bundle, package manager for DEB/RPM, or explicit manual. Inspect actual package,
path, execution architecture and write permission. Never silently switch owner,
package or location. Disk-image/translocated macOS and unsupported custom/system
installs receive accurate bootstrap/manual guidance; user-owned updates must not
silently require elevation.

The release record declares CLI protocol range, catalog formats/capabilities,
library read/write schema interval, migration start/end and lock protocol. Query
core for actual schema and sessions/mutations. Probe an explicitly configured
companion CLI's existing capabilities contract, never arbitrary search-path binaries.
Unknown companions are not declared compatible.

Initially support mixed CLI/Desktop only when both declare the same write schema
and lock protocol with compatible machine protocols/capabilities. No cross-schema
concurrent writers are implied. Core rejects newer or partial schemas under its
migration lock. When Desktop advances schema, an incompatible old CLI must refuse
access with repair guidance; Desktop does not overwrite the CLI. Stable/Preview
share a library only under this compatibility/lock contract, otherwise use distinct
user-selected libraries. Channel preference never copies mutable data.

Normal updates strictly increase maintained SemVer precedence. Build metadata alone
is no increment. Preview-to-Stable records preference and waits for compatible
non-older Stable. Explicit recovery has a separate confirmation/compatibility gate.
Skipped upgrades require a supported complete migration chain or authenticated
compatible bridges; no silent downgrade or data discard.

## Recovery without rolling back user data

Host state records candidate identity, eligibility snapshot, owner/platform path,
previous successful identity and replacement phase. At apply acquire the shared
cross-process guard and recheck sessions/mutations, consent, ownership, links/paths,
disk, compatibility and fresh eligibility. Races hold the candidate. Crash, shutdown
and Steam Stop cannot guarantee exit hooks; next launch reconciles journal phase
against actual installed identity.

Journal staged -> verified -> applying -> awaiting health -> successful with
recoverable writes. Retain the immediately previous successfully installed signed
identity, manifest and payload where the platform permits safe recovery. Unhealthy
or interrupted candidates never replace that previous slot. Health includes core
open/migration postconditions and host bootstrap, not just executable startup.
Qualify interruption at each phase per platform before claiming automatic recovery.

Core migrations stay contiguous, transactional and postcondition checked under the
existing OS migration lock. Cross-file/schema steps use core's recoverable journal
and idempotent reconciliation; the host must not create a competing library restore
authority. Keep libraries, sources, game installations, saves, backups, settings,
artwork, trust state and credentials outside replaceable application payloads.

Binary rollback is allowed only to the exact previous successful signed version
when current eligibility, payload-key authority, owner/package, OS and actual current
mutable schema remain compatible. Do not restore old database/save snapshots to
make an old binary run. Missing freshness holds automatic rollback and offers
independent data-preserving repair. Signed but withdrawn/incompatible binaries are
not recovery targets. Prefer a newer eligible forward repair.

Recovery must work without the new GUI: documented verified manual reinstall or a
qualified recovery launcher reads the host journal, identifies the exact install
and preserves every user path, without elevating the failed candidate. Updater-less
alphas need verified manual bootstrap. Package/migration proofs must demonstrate
newer saves survive forward repair/interrupted replacement/refused downgrade.
TUF alone supplies none of these native installation guarantees.

## Executable evidence and limits

Run `cargo test --locked -p portcove-desktop --test updater_trust` through the existing
development-storage wrapper; normal workspace checks include it. The host loader
uses the actual Rust TUF client; its editor and fresh Ed25519 PKCS#8 signing keys
remain development-only dependencies. No private-key fixture, production endpoint
or updater plugin is shipped.

Fixtures cover quorum and dual-root continuity, one-key loss, insufficient/online
key rejection, skipped/missing bridges, revoked online signatures, persistent replay,
expiry, equal-length target tamper and a separately signed channel delegation.
Host-state fixtures additionally prove version and signed-body floors after the TUF
cache is removed, same-process serialization, clock-regression refusal, source
refusal before state mutation, and recovery from a failed initial bridge plus a
failed post-rotation refresh after the remote bridge disappears. The channel fixture
refuses the release key and reads promotion bytes through the actual delegated
verifier. Simplified local roles and non-consistent filenames keep the key-lifecycle
scenarios bounded. A user-data sentinel establishes only that metadata failures
preserve that file, not binary rollback or save migration. Network policy, full
production role layout, payloads, compatibility/journal and physical platforms need
their applicable implementation proofs before activation.

References inspected 2026-09-08: [TUF specification](https://theupdateframework.github.io/specification/latest/),
[`tough`](https://github.com/awslabs/tough), [Tauri updater](https://v2.tauri.app/plugin/updater/)
and downloaded `tough` 0.24.0 / `tauri-plugin-updater` 2.11.0 registry sources.
