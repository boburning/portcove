# Releasing Portcove

## Release task order

Use this route for the exact candidate and platforms being claimed. The current
[Slice 4 producer, activation and storage holds](#inactive-slice-4-input-integration)
and [protected tag/publication boundaries](#roadmap-readiness-snapshot) remain
effective. Preparation, a successful rehearsal and an ordinary merge each retain
their own scope; publication requires its existing explicit authority.

The first public beta application release is Windows x86-64 only at the existing
supported Windows/WebView2 baseline. Follow the
[Windows/shared release boundary](DELIVERY.md#first-public-beta-host-boundary).
Linux remains planned for a subsequent beta; retain its implementation, metadata
and completed/unfinished evidence without requiring an unshipped Linux or macOS
application artifact for this launch. Shared checks keep their appropriate hosts.
The additive `initial-beta-windows-x86_64-v1` profile must be delivered through
the existing machinery and qualified on actual candidate bytes before use; this
document does not claim it is implemented or authorize publication. The `full`
and historical `initial-beta-win-linux` paths remain explicit broader profiles.

### Preflight

Establish the [frozen source and input identities](#frozen-source-consistency)
and the applicable [readiness record](#roadmap-readiness-snapshot). For Windows,
follow [Windows preflight](#windows-preflight); the
[isolated installer checks](#isolated-windows-installer-checks) explain its
expected lifecycle evidence. Retain a failed command's output and owned evidence
before diagnosing or repeating that step.

### Build matrix

Use the [declared package matrix](#declared-package-policy) for the required
Desktop and standalone CLI outputs by operating system and processor.
[Tagged build](#tagged-build) explains the actual producers, native Intel
verification, checksum reconciliation, SBOM and draft assembly. The separate
[release rehearsal](#release-rehearsal) exercises packaging without creating a
tag, attestation or release. Each claimed platform keeps its own
[upgrade acceptance](#upgrade-acceptance-and-technical-previews) and
[signing/trust requirements](UPDATER-TRUST.md#owners-and-independent-trust-claims).
Linux packages retain their [package-manager or AppImage ownership](UPGRADING.md#linux-package-choice).

### Publish

Follow the [frozen candidate's authorization boundaries](#roadmap-readiness-snapshot)
and [draft review steps](#release-rehearsal). Review the tag build's exact assets,
notes, checksums, channel and evidence before separately authorized publication;
rehearsal bytes do not certify a later build. Then complete
[public asset and attestation verification](#post-publication-verification-and-release-channels).
Existing published releases and historical manifests remain unchanged.

### Retain evidence

Keep the linked [pre-publication snapshot and execution record](#roadmap-readiness-snapshot):
exact source, run and attempt, package digests, selected platform observations,
required check results, failures and limitations. Installer/session receipts
retain their [process and preservation observations](#isolated-windows-installer-checks).
Follow the existing [attempt-artifact retention and custody rules](#tagged-build);
expiry is not proof of successor custody or free capacity. For retained native
inputs, use the [verification evidence store](DEVELOPMENT-STORAGE.md#retained-verification-evidence).

The existing [installed Windows update and staging-recovery guide](media/application-update/README.md)
contains authentic test-build media and its exact receipt. The
[first-launch guide](media/first-play/README.md) records a separate Windows
development-build game journey. Their build, environment, input and observation
limits remain attached to those guides; neither is qualification of a new
release or a production update feed.

## Inactive Slice 4 input integration

The prepared semantic input wire uses summary schema 2: the complete validated
opportunity/digest plus actual independent report bytes/digest, runtime/session,
whole-second UTC completion and accumulated-change/classification/compatibility
coverage. Persisted classification schema 2 binds the entire verified provider
proof digest. The existing envelope title ending `v1` is not permission for a v1
summary. Legacy summaries/records refuse; they are never silently overwritten or
migrated. Historical coordinator schema-1 replay is unchanged.
`release-semantic-review.mts` is an inactive serializer, not authenticated runtime
capture or acceptance. The writer and generic Actions remain excluded issuers.

The held runtime's accepted handoff also requires completed frozen-reader
observations of the opportunity, publication baseline, accumulated-change
metadata, and classification/compatibility evidence. Observations must match
frozen bytes and cover the changed portions with containing-line context in
both snapshots. Listing, empty output, token reads, truncated search results
and echoed coverage flags alone cannot establish this prerequisite. Unchanged
source bytes need no exhaustive read. Delivery of evidence is necessary but
does not establish sound semantic judgment or grant capture/issuer authority;
unavailable evidence retains changes-required/refused outcomes. Existing
production activation and storage holds remain separately owned.

The prepared capacity configuration reader uses `portcove-release-pause` /
`capacity.json`, verified raw Git objects and two exact-ref reads, with mandatory
authenticated fresh observer/job guards. The document contains schema version 1,
the ratified D2 `capacity`, and `observation` identifying provider-UI spending
configuration, actor 43177418, time and retained evidence SHA-256. Configuration
cannot supply operation history. Revoked/invalid configuration is ineligible;
missing, conflicting or drifting provenance refuses. Successful parsing never
proves live account settings, capacity availability or headroom. No source is
installed by this reader. Availability/headroom stay Unknown; reservation none.
See the [current checkpoint](qualification/slice4-producer-and-144-checkpoint-2026-10-18.md)
and [canonical packet](qualification/slice4-production-authorization-packet-2026-10-18.md)
for the actual producer blocker and remaining protected execution prerequisites.

Portcove releases fail closed when the product version, Git tag, required identity assets, tests, or catalog ownership checks disagree. Tagged builds remain draft releases until their platform artifacts and checksums have been reviewed.

## Frontend and signing environment boundary

`VITE_` variables are public renderer inputs and must never contain secrets.
The desktop build command runs typechecking and Vite in children that omit all
`TAURI_SIGNING_` environment variables, including key, key-path and password.
Native target/debug variables remain available to those children, but Vite does
not expose the broad `TAURI_` namespace to renderer code. Source maps remain
enabled. Tauri packaging/signing retains its original parent environment; that
native stage receives private signing inputs. Ordinary builds and disposable
updater rehearsals use this shared frontend build command. Do not put signing
inputs in frontend environment files or public `VITE_` variables.

Portcove releases fail closed when the product version, Git tag, required identity assets, tests, or catalog ownership checks disagree. Tagged builds remain draft releases until their platform artifacts and checksums have been reviewed.

See [Continuous verified delivery](DELIVERY.md) for the approved future
version/channel, platform-updater and zero-cost automation policy. Current
protected publication remains effective until separately authorized activation.
In particular, suffix-free 0.x publication is blocked by the required release
classification implementation: the current suffix-only workflow would classify
it incorrectly. Do not invoke it for a suffix-free beta.

For a routine preview, `roadmap.mts candidate-scope --issues <issue,issue,...>`
checks the frozen implementation scope without waiting for unrelated milestone
capabilities. It grants no publication authority and replaces none of the gates
below. Declaring Public beta or 1.0 also requires the corresponding cumulative
`readiness` and snapshot evidence. #532/#533/#534 own classification, bounded
automation and separately authorized one-time provisioning respectively.

## Offline updater artifact rehearsal

`release/tauri.updater.conf.json` is an explicit packaging overlay. It enables
Tauri v2 updater artifacts, current-user NSIS with passive updater installation,
and ad-hoc macOS signing. Ordinary configuration still disables updater artifacts;
no endpoint, runtime updater plugin, or production key is installed by this overlay.
An updater signature is distinct from Authenticode, notarization, and catalog trust.
The Windows overlay keeps an explicit `bundle.windows.nsis` options object.
With the pinned Tauri CLI 2.12.2, the [versioned NSIS bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L345-L417)
reads the generic WebView2 minimum only inside that options branch. A null
NSIS configuration silently omits it. Inspect the generated `installer.nsi`:
`MINIMUMWEBVIEW2VERSION` must equal the declared engine floor; an empty value
does not establish the installer's minimum-runtime update behavior.
Tauri's bundler requires the corresponding public key in its merged updater
configuration. The rehearsal creates a temporary copy of the overlay containing
its disposable public key; a bare overlay without that key deliberately cannot
produce an updater package.

The manual **Updater artifact rehearsal** workflow generates disposable keys on
each runner and builds every required Windows, Linux, Intel Mac and Apple Silicon
package for the selected fixture transition: `legacy-adjacent` uses 0.1.0 to
0.2.0, `legacy-skipped` retains 0.1.0 to 0.3.0, and `preview-final` uses
1.0.0-rc.2 to 1.0.0. Each profile builds only its two endpoints and follows the
same installed-app selection, staging, replacement and restart path. The default
remains `legacy-skipped`; choosing a profile is not evidence it passed.

For #225's historical manual-bootstrap observation, select only `linux-x86_64`,
a legacy transition and `historical_linux_bootstrap: true`. The optional prelude
uses the pinned published Alpha 2 AppImage and its matching CLI, saves a real
library choice in an empty private library, then creates its preservation marker
once. The same installed path, library and preferences continue through ordinary
Alpha 2 startup/close, manual replacement by the updater-enabled predecessor and
the existing authenticated Settings journey. Before closing Alpha 2, require its
settled empty-library view and normal Settings readback of the exact saved library
choice; inspect the retained screenshots separately. The qualified predecessor
then performs a fresh Stable no-candidate check with unchanged AppImage bytes
before explicitly selecting Preview through the shared Settings journey.
Historical input signatures/feed
remain explicitly absent. The maintained process-tree supervisor gives this
consumer a 300-second execution budget after admission/setup, including with an
inherited lease. Retain failed runs and cleanup settlement; a selected mode is
not native acceptance. This chain does not create a desktop entry.

After manual replacement, the same opt-in uses the builder-retained matching
predecessor Core CLI to install the existing OpenTyrian catalog entry normally.
The retained CLI receipt joins the source, version, binary hash and staged archive
inventory before use. It then copies exactly three provenance-pinned,
checksum-valid game-authored save/configuration files into a new private external
OpenTyrian store; an existing store is refused. Original runtime files, installed
record/artifact identity, game-update policy and player-file bytes are compared
before and after authenticated candidate return. Original runtime/player files
are captured before the additional observer CLI runs; installed records and
policy are then read back through status. Candidate startup may already reconcile
Core state, so this does not claim an unreconciled database preimage. The fixture
does not copy a library database or execute the game. This renderer chain does
not uninstall; separate lifecycle controls do not prove this dataset survives
uninstall.
Its generator provenance and limits live in
`scripts/fixtures/application-update-game-data/manifest.json`. In-game loading,
gameplay, personal history, credentials and managed backup coverage of external
game data remain unclaimed. A selected mode or component pass is not installed
updater preservation evidence. Production authority and real release-to-release
acceptance remain with their owning gates.

For a separate Windows real-data observation, the existing disposable renderer
upgrade accepts `-InstalledGameDataConfigurationPath` and its exact SHA-256.
It excludes public/account-bound routes and the historical bootstrap prelude;
those retain their separate receipts. Use a new private case directory containing
an empty retained-library sibling of `TestBase`, a source/version/hash-bound
matching Core CLI receipt, and a closed configuration with `schema_version: 1`,
`cli_receipt`, `cli_source_commit`, `library` and `preferences_path`. Set
`APPDATA`, `LOCALAPPDATA` and `PORTCOVE_PREFERENCES` to private children of that
case. Preflight requires both stores empty and host preferences absent before
any installer or Core mutation.

After the predecessor is verified, normal Core saves the library choice,
installs OpenTyrian and copies the same three game-authored files once. Existing
damaged-stage/repair/update controls then run. The empty-library WebView startup
smoke uses separate new library/preferences paths for either transport and
restores the original absent/empty/value environment exactly before the real
updater renderer starts. Its empty-state assertions remain intact; that smoke
supplies no observation of the populated game library. After uninstall's original
recursive-library comparison, the observer captures original runtime/player
files before additional Core status, checks the original installed record/policy
and exact saved-library preference bytes, and writes retained evidence outside
the disposable installer run. A selected option is not evidence of completion.
The Windows real-data route and historical Linux renderer route additionally
exercise a bounded outage of their owned local `timestamp.json`. They persist
exact control/preimage identities before driver dispatch, observe an ordinary
check reporting the sanitized reachability failure without new staging/apply
state or changed saved updater choices, restore the original timestamp inode
and bytes, then retry through the ordinary controls. Scheduling failure/retry
counters may legitimately change. The installed executable/AppImage hash and
existing data comparisons remain required. Repeated Stable/Manual setup confirms
an already-saved choice through the shipping read-only preference query instead
of clicking a correctly disabled, unchanged Save control. An enabled Save still
uses its normal UI action, and the fresh one-time check remains mandatory.
This is file-feed reachability
coverage, not OS-offline, HTTP redirect/rate-limit, production TLS or publication
acceptance.

The fixture adapter verifies same-filesystem no-replace hardlinks before
withholding anything and reuses the existing process-identity lock for its
mutating window. Parent restoration refuses active/unknown mutators, seals out
late fault writers and refuses foreign files or changed retained preimages.
Exact controls and originals remain available on failure; resuming restoration
uses the retained configuration and its original SHA-256 with
`node apps/desktop/scripts/desktop-installed-feed-outage.mts --phase restore --configuration FILE --sha256 SHA256`.
Do not recompute an expected digest from altered inputs or overwrite a foreign
replacement. This establishes bounded process-interruption recovery, not
power-loss/directory-durability or actual reboot behavior. Selecting the fixture
does not establish that its installed observation completed.

The historical Linux real-data chain also holds one genuine public Core update
activity before launching the updater-enabled renderer. The Windows real-data
route opts into the same seam with `-InstalledLibraryBusyHelperPath`, its exact
`-InstalledLibraryBusyHelperSha256` and `-InstalledLibraryBusyHelperSource`.
These require the existing hash-bound game-data configuration; public/account
routes remain separate. Use the compiled `prepare_installed_update` example from
the existing stripped `controller-tools` profile. Its `describe` command supplies
Core's actual library schema and lock protocol; the requested description version
is helper-contract input, not installed-predecessor version or source evidence.
Record exact helper byte identity and builder source separately from application
package identities.

Start the holder after normal seed/observer processes exit and before renderer
startup. The helper verifies the existing active installation and current schema,
then waits inside the normal public update's Started callback with its genuine
durable Running activity and continuously held Core activity lock. A temporary
quiescence-admission lease is not the busy witness. The ordinary enabled Restart
must produce a fresh canonical Conflict alert, with unchanged verified staging,
preferences, installed image and original application process, no apply intent
and no updater/relaunch marker. An already-present alert or disabled button does
not satisfy this observation.

Only after that refusal, send the nonce/activity-bound cancellation through the
owned child's stdin. Require Core's cancellation acknowledgement, durable
Cancelled record, matching Finished event, zero provider acquisition, idle library
and observed child OS exit 0 before the existing fresh explicit Restart click.
The helper never executes the game or creates an update row with SQL. Invalid
release, EOF or its finite wait limit exits 86 without inventing a Core terminal
result. Retain unresolved activity/output and settle the original owned child
before another observer or driver teardown; a failed case stays failed even if
cleanup succeeds. Controller protocol tests use explicitly fake producers and
do not establish Core or installed acceptance.

Ordinary Linux lifecycle and historical real-data stable targets include spaces
and Unicode. A separate bounded tmpfs fixture is prepared with `noexec` by the
existing privileged setup; the copied exact AppImage is tested by the ordinary
UID with no effective capabilities and mode 0755. The fixed probe verifies the
actual mount before attempting execution and accepts only kernel EACCES with no
started process. It retains raw mount/launch outcomes and rechecks the original
stable file and synthetic lifecycle data. This is mount/noexec refusal, not
successful application execution, painted guidance, reboot or real-game data
preservation in that separate fixture. Explicit artifact paths retain these
reports and the holder/descriptor output without including profiles or credential
stores. All these selected scenarios still require actual installed receipts.

The fixed Windows OS credential store is not isolated by these private paths;
credential continuity, gameplay and raw database-preimage claims remain absent.
The caller must retain the configuration, CLI/package/source custody and all
phase reports, including failures. No signing/publication authority is added.

It checks native package versions and
executable permissions. The Linux job defaults to the approved Ubuntu 24.04
support environment; `linux_runner` retains Ubuntu 22.04 for scoped diagnostic
observations, which cannot qualify the supported minimum.
Its retained host baseline records the actual OS, kernel, glibc, WebKitGTK and
FUSE package versions. Production Linux bundles are produced on Ubuntu 24.04 so
the AppImage does not inherit the older Jammy WebKit engine. Compilation-only
Ubuntu 22.04 checks remain separate. Inspect the distributed AppImage's actual
loaded libraries; the host's installed package version alone is insufficient.
The [design-system support policy](DESIGN-SYSTEM.md#compatibility-and-qualification-boundary)
and #993 own the exact engine floor and still-required minimum observations.
No Steam Deck compatibility follows. Windows builds a disposable
test-signed TUF repository,
embeds its public trust and local repository URLs in a qualification-only
predecessor NSIS package, and uses the installed predecessor to select the signed
candidate and stage fixture-supplied installer bytes through the desktop
check-and-stage operation. The harness first requires a one-byte truncated
installer to fail with empty staging, then a same-length corrupted copy to fail
against the authenticated SHA-256. The latter receipt retains expected and
observed lengths and digests, and proves that staging remains empty and the
predecessor, library marker and original candidate remain unchanged. It then injects a malformed staging
journal and stray payload, and requires the installed executable's
GUI-independent status and targeted staging repair commands to preserve the
registered predecessor and library marker. The renderer then downloads a fresh
candidate, invokes the installed application's passive update helper, observes
candidate relaunch and reconciliation, then uninstalls with data
preservation. The fixture prepares only the later apply intent externally;
normal renderer download and restart, a non-administrator VM prompt sequence,
production signing, and publication require separate evidence.
Windows native session creation retains a bounded, one-second sampled inventory
of the selected driver and its creation-time-checked descendants, executable
versions, presence of remote-debugging arguments, and the isolated profile's
`DevToolsActivePort` presence. The observer starts before session creation and
stops afterward, including on failure; it does not change WebView policy or
launch or terminate the application. Sampling can miss short-lived processes.
It does not report attached application exit codes or application stderr, and
an absent endpoint alone does not establish why session creation failed.

The disposable Windows installed-updater predecessor enables the existing
qualification-only embedded WebDriver, with its main-window capability overlay.
Its candidate installer retains the ordinary feature set. The explicit embedded
transport runs installed startup smoke checks before and after fixture setup,
then the shared renderer check, stage and restart journey. Startup smoke is not
the complete desktop empty-library scenario. Each listener must belong to the
directly launched installed executable on `127.0.0.1`; process snapshots bind its
parent, creation time, path and initial hash. Cleanup uses an application-root
snapshot, distinct from official-driver ancestry. Application output and process
evidence are retained on failure. The tree is refreshed after session startup and
while the root remains live during cleanup. If startup exits before that boundary,
or no tree was captured, later descendant cleanup is explicitly unproven and the
qualification fails; disappearance of the root is not a containment guarantee.
Successful updater qualification still requires
the signed candidate, marker-bound helper/relaunch, natural exit and preserved
state checks; embedded transport or startup alone does not establish it.
Linux builds a disposable test-signed TUF repository, embeds its public trust and
local repository URLs in the selected qualification-only predecessor AppImage,
and exercises the
packaged helper through an interrupted candidate copy, GUI-independent command
recovery without a display server, and retrying replacement with the selected
candidate under
Xvfb. The installed predecessor selects the candidate with its compiled provider
and stages fixture-supplied bytes through the desktop check-and-stage operation;
the external fixture prepares only the later apply intent. Before granting staged
or apply authority, the harness removes one byte from the authenticated candidate,
requires an exact length-mismatch failure, and proves
the stable AppImage, empty staging state, and library sentinel remain unchanged.
It then retries the exact candidate and continues the normal sequence. Before
replacement, the harness presents an unsupported future apply-journal
schema to the packaged helper, requires exit code 1 without replacement and a
stable-predecessor restart, and proves the journal, staged payload, staging state,
predecessor, and user data remain exact before restoring the supported fixture. A
second attempt removes owner write permission from the complete update-state
directory, requires exit code 1 without replacement and a stable-predecessor
restart, and proves the supported journal and the same pending bytes remain exact
before restoring every file and directory to its exact prior Unix mode.
A third attempt copies the pending state into a bounded disposable `tmpfs`, fills
that filesystem to zero available bytes, and requires the packaged helper to fail
with exit code 1 and restart the predecessor while the complete pending inventory,
stable AppImage, and user data remain exact. The harness removes only its filler,
proves writes work again, and unmounts the fixture before continuing.
A fourth attempt keeps an isolated update-state copy writable while hosting the
stable predecessor on another bounded `tmpfs` filled to zero available bytes. It
requires the candidate-copy failure to remove any partial sibling, preserve the
exact predecessor and staged candidate, record the failed launch with its exact
attempted replacement identity, and restart the predecessor. The harness then
exercises the explicit retry transition and requires it to clear that failed attempt
while retaining the intent and staged candidate. It removes its filler, proves
writes recover, and unmounts the AppImage fixture before continuing.
A separate process then holds the shared application-runtime lock; the helper must
remain blocked with the stable predecessor, staged payload, and apply journal
unchanged, then continue after that peer exits. The retry is interrupted after the
atomic exchange and directory sync but before journal success.
The run verifies the partial swap, exact predecessor and retryable journal after
pre-activation recovery, then the candidate at the stable path and the exact
predecessor backup before a candidate startup reconciles the request. It finally
verifies the stable candidate hash and executable bit,
healthy-startup journal reconciliation, staging and backup cleanup, and preservation
of a library sentinel throughout the sequence.
It deletes the disposable TUF private keys before starting either AppImage and does
not upload private keys or mutable updater state.
The same packaged Linux run uses a direct current-user stable AppImage path and an
absolute desktop entry, retains exact library, game-file, save, backup and log
markers through replacement, then performs the documented bounded rootless
uninstall. The uninstall removes only the AppImage and that entry and proves every
data marker remains exact. This is Ubuntu-hosted packaged lifecycle evidence, not
SteamOS/Game Mode, removable-storage, physical-device or human setup evidence.
These are fixture versions, never publication or release-readiness declarations.
The script requires a clean tracked checkout, records the exact source commit and
version-only source patch, restores metadata, and deletes its disposable private
key. Prior build outputs are preserved under its new evidence directory.

The Linux packaged run is Ubuntu-hosted AppImage evidence with disposable keys.
Fixture payload acquisition and external apply-intent preparation do not establish
the normal desktop download and restart interaction, production signing, universal
distribution compatibility, Steam Deck behavior, every interruption phase, or the
remaining distro evidence tracked by the live roadmap issue.

The manual **Linux package ownership rehearsal** is the smaller DEB/RPM companion.
It builds only those two native packages on Ubuntu 24.04, then verifies DEB through
Ubuntu's package database and RPM through a Fedora container's native DNF transaction
and RPM database. Each installed desktop executable runs the GUI-independent
eligibility inspection with no display. The run requires format-specific guidance
back to the same package source, hashes the installed executable before and after
inspection, and removes the package. Its one-day per-format evidence records the
exact commit, package hash, installed executable hash and mode, package name, native
platform, and displayed guidance. This is focused ownership evidence; it does not
repeat the AppImage update lifecycle or establish broader distro qualification.

`scripts/updater-artifact-inventory.mts stage` selects the complete existing package
matrix, copies final distributed bytes into a new directory, hashes them, verifies
the updater signature, records the SHA-256 of the decoded canonical Minisign public-key
file, and writes `updater-inventory.json` last. The outer Tauri base64 wrapper is an
input encoding rather than the payload-key identity. Windows and Linux
reuse NSIS/AppImage bytes. Mac updater archives are copied without rebuilding to
versioned architecture-specific filenames, avoiding the shared `Portcove.app.tar.gz`
name. CLI, DEB/RPM and DMG remain inventoried companions with their existing owners;
they are not activated as alternate updater formats.

The `verify` operation rechecks exact commit/version/platform/package identities,
the complete staged file set, every hash and size, and the signature against an
independently supplied public-key file. Both operations require `--label`,
`--revision`, `--public-key` and `--verifier`; use `stage --output PATH` or
`verify --input PATH`. The verifier is the built `portcove-release-tools` binary.
Only verification accepts `--version` to check a historical fixture explicitly.
Inventories are evidence, not trust roots or executable feeds. Altered/rebuilt
packages require new verification and cannot inherit previous package evidence.

`scripts/reconstruct-application-update-records.mts` is the offline bridge from
those verified inventories to the application record schema. It accepts a bounded
source descriptor, a separate reviewed eligibility map and an output directory:

```powershell
node scripts/reconstruct-application-update-records.mts `
  --input work/update-record-inputs.json `
  --eligibility work/update-eligibility.json `
  --output work/update-records
```

Each descriptor entry points to the raw `updater-inventory.json` and its exact
`.sig` file and supplies the frozen source tree, qualified workflow revision/run,
installed execution context, compatibility contract and evidence IDs. Paths are
relative to the descriptor and must remain inside the project. Run the inventory
`verify` operation immediately before reconstruction; the descriptor and local
eligibility file do not authenticate themselves.

The tool computes the raw inventory SHA-256, emits immutable
`releases/<version>/<target>/<package>.json` records and versioned
`channels/<channel>/<target>/<package>/<version>.json` promotions, then writes a
deterministic content-addressed manifest. Repeating identical complete input is a
no-op. Derived channel output and a partial prior write are replaced atomically,
but changing or omitting an existing immutable release record fails. Supply the
complete retained inventory history when rebuilding. TUF role signing, GitHub
Pages publication, keys, endpoints and updater activation remain outside this
JavaScript reconstruction operation and retain their separate boundaries.

Build the separately signed TUF repository from that record tree with the offline
Rust release tool:

```powershell
cargo run --locked -p portcove-release-tools -- build-tuf work/tuf-build.json
```

The strict configuration resolves paths relative to its own directory:

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-12T10:00:00Z",
  "trusted_root": "keys/1.root.json",
  "reconstructed_records": "update-records",
  "payload_key_registry": "keys/payload.json",
  "output": "update-repository",
  "keys": {
    "targets": "keys/targets.der",
    "snapshot": "keys/snapshot.der",
    "timestamp": "keys/timestamp.der",
    "releases": "keys/releases.der",
    "preview": "keys/preview.der",
    "stable": "keys/stable.der"
  },
  "versions": {
    "targets": 1,
    "snapshot": 1,
    "timestamp": 1,
    "releases": 1,
    "preview": 1,
    "stable": 1
  },
  "expires": {
    "targets": "2026-12-11T10:00:00Z",
    "snapshot": "2026-09-19T10:00:00Z",
    "timestamp": "2026-09-14T10:00:00Z",
    "releases": "2026-12-11T10:00:00Z",
    "preview": "2026-09-19T10:00:00Z",
    "stable": "2026-09-19T10:00:00Z"
  }
}
```

In schema 1, all six role keys must be distinct PKCS#8 Ed25519 private keys. The signed root
must already authorize the supplied targets, snapshot, and timestamp keys; release,
Preview, and Stable become direct delegated roles. The root must require consistent
snapshots, retain at least three offline keys with a two-signature quorum, and keep
its single-key online roles distinct. The generation time cannot be more than five
minutes ahead of the signing host. Timestamp expiry is limited to 48 hours, snapshot
and channel expiry to seven days, targets and release expiry to 90 days, and root
expiry to one year.

The operation verifies that the reconstruction manifest exactly inventories its
bounded record tree and that the payload registry binds each base64 public-key file
to its SHA-256 identity. It stages metadata and consistent-snapshot target names,
writes `repository-manifest.json`, and atomically publishes the new local output
directory. Repeating the same logical build verifies and reuses the existing output;
changed target bytes, role versions, expiry values, signatures, or manifest content
fail closed. The tool reads each bounded private-key input once and gives `tough`
only that immutable in-memory snapshot; private keys are never copied into repository
output or another file.

Schema 2 separates offline bootstrap from routine role signing. For bootstrap,
use the same fields with `schema_version: 2`, include `keys.targets`, and omit
`offline_targets`. The signed top-level targets fixes the payload-key registry,
three distinct delegated keys, and Windows NSIS/Linux AppImage namespaces:
`releases/*/windows-x86_64/nsis.json`, `releases/*/linux-x86_64/appimage.json`,
and the corresponding versioned `channels/preview` and `channels/stable` paths.
Bootstrap is an offline custody operation; this tooling does not grant production
custody or signing authority.

The older schema-2 `build-tuf` mode can omit `keys.targets` and consume exact
`offline_targets` bytes with the other five keys together. That consolidated
builder remains an offline setup/qualification tool, not the routine production
custody path. Initial setup must supply a valid signed empty Stable role and
complete public seed repository. Root and top-level targets keys stay offline.
Renewing targets, changing delegation keys or changing the payload registry
requires independently authorized offline setup.

### One-key initial offline ceremony

The legacy instructions below retain their existing two-of-three Root and
offline Targets contract. The separately approved
[single-owner initial setup](qualification/slice4-hosted-continuity-first-2026-10-22.md)
uses the explicitly selected `initial_root_profile: "single-owner-one-of-one-v1"`
in independently ratified configuration. That profile prepares exactly one Root
public key with threshold one; one signing invocation completes its quorum and
another signature attempt refuses. Omission still selects
`legacy-two-of-three-v1`. Neither metadata nor a candidate may select the expected
profile, and an existing published Root cannot be replaced by treating it as a
new initial setup. Reconcile actual public Root/rotation history first.

The approved single-owner arrangement uses separate application and catalog keys
in one encrypted recovery vault with a ciphertext-only backup, without extra
drives or independent custodians. It accepts loss of independent quorum
resilience; connected encrypted storage is not air-gapped custody. Root remains
outside Actions and reviewer access. Actual file ownership, encryption, restore,
wrong-key refusal and public fingerprints still need setup evidence. This
changes initial custody, not the maximum 365-day Root expiry or verification of
existing trust. It does not require routine per-artifact owner stamps.

The recovery-tool prerequisite has a separate opt-in Linux x64 path:

```sh
mkdir -m 700 work/recovery-tool-cache
node scripts/prepare-recovery-tools.mts --prepare "$PWD/work/recovery-tool-cache"
```

It provisions only a private, fingerprinted public-tool cache. The separate
`.config/recovery-tools/aqua.yaml` pins age 1.3.2 and its GitHub CLI verifier;
ordinary frontend/native profiles do not install them. The Linux Aqua bootstrap
is checksum/version pinned without changing global shims or persistent environment.
Other hosts refuse before effects; Windows x64 archive checksums are prepared
inputs, not Windows bootstrap qualification.

Aqua's own attestation path can skip authentication errors and retry. This
installer therefore uses Aqua only to stage checksum-pinned packages, then
requires one successful direct GitHub CLI verification of the exact age archive,
source commit, release tag and producer workflow before executing age. The
verifier itself must match the exact archive checksum embedded in the pinned
Aqua source. The installed age and age-keygen bytes must match that attested
archive. Warm reuse rechecks original pinned archives, executable bytes and the
retained verification result; a partial cache, alias or changed bytes refuses
without reinstalling or overwriting the original attempt. Downloads and commands
have finite bounds under the maintained process/resource supervisor.

This tool bootstrap supplies no custody, credential placement, production signing
or publication authority.

`scripts/catalog-recovery-vault.mts` supplies the separate offline catalog-only
adapter. `prepareCatalogRecoveryPlan` requires independently ratified release-tools
binary/source identities, the exact selected catalog configuration bytes, its
public Root/Targets pins, and public fingerprints from the appointed two-App
captures. It snapshots the binary and public inputs privately and invokes the
read-only `inspect-catalog-key-inventory` command. That command verifies signed
Root/Targets structure and derives every appointed catalog role key; it deliberately
does not grant freshness, signing or private custody. The public-only
`inspectCatalogRecoveryPlan` cannot create a usable vault session.

`createCatalogRecoveryVault` accepts an already-authorized owner custody callback,
invoked only for the derived complete appointments. Each catalog key must pass
the existing Tough `inspect-existing-tuf-key` projection through that same pinned
binary; each App RSA key must match its captured SPKI fingerprint. A parsed
configuration, prepared local session or available credential never authorizes
that callback. Vault preparation and custody acquisition reject Actions runtimes
and UID 0; reviewer identity and owner custody still require the separate grant.
Actual custody reads remain held until their separate prerequisites
are satisfied. No discovery, key generation, Root rotation or provider operation
exists in this adapter.

The create-only private output contains an authenticated age ciphertext and a
public completion receipt. The native recipient API remains available for
separately appointed identity holders: identity bytes travel through stdin,
never arguments, environment variables, logs or temporary identity files.
The ordinary-owner CLI uses the selected passphrase profile instead. It shares
the same complete catalog vault, inspectors and durable completion boundary.
It does not appoint an additional age identity.

Existing `prepareRecoveryTools` qualifies the exact standard age executable
before private reads. Native recipient subprocesses retain their 30-second
ceiling. Direct passphrase subprocesses have a 120-second ceiling, a sanitized
environment and bounded output. Pinned age 1.3.2 creates the single-scrypt logN18
profile (256 MiB principal KDF memory); restore refuses any other header before
asking for a secret. This resource fence and the separately retained ciphertext
SHA do not replace age authentication. Bundle size is at most 1 MiB and each
private key at most 32 KiB. Caller custody callbacks must themselves be bounded
and return a fresh transferred buffer; returned buffers are cleared after
consumption. JavaScript heap strings do not provide guaranteed secure erasure.
The recovery bootstrap retains its own pinned Aqua archive/source/version,
separate from the ordinary quality manager's `.aqua-version`. Updating that
quality manager cannot retarget recovery tools; recovery archive, checksum,
binary-version and source-bound proof checks still run unchanged.

`scripts/catalog-recovery-vault-cli.mts` accepts a closed public JSON configuration:

```json
{
  "schema_version": 1,
  "profile": "catalog-owner-passphrase-tty-v1",
  "configuration": { "path": "/absolute/selected-catalog.json", "sha256": "RATIFIED_SHA256" },
  "app_public_captures": {
    "semantic": { "app_id": 101, "public_key_sha256": "ACTUAL_CAPTURE_SHA256" },
    "protection_observer": { "app_id": 202, "public_key_sha256": "ACTUAL_CAPTURE_SHA256" }
  },
  "inspector": {
    "path": "/absolute/qualified-release-tools",
    "sha256": "RATIFIED_BINARY_SHA256",
    "source_commit": "RATIFIED_SOURCE_COMMIT",
    "source_tree": "RATIFIED_SOURCE_TREE"
  },
  "public_inputs": {
    "trusted_root": "/absolute/appointed-root.json",
    "offline_targets": "/absolute/appointed-targets.json"
  },
  "tool_parent": "/absolute/qualified-public-tool-cache",
  "private_parent": "/absolute/owner-private-0700-working-directory",
  "key_paths": { "ACTUAL_DERIVED_ROLE": "/absolute/existing-appointed-private-key" }
}
```

The example IDs and digest labels are placeholders, never production captures
or pins. `key_paths` must name exactly every role derived from the authenticated
public Root/Targets and the appointed two-App captures, with distinct ordinary-owner
single-link private files. The CLI never discovers, generates or installs keys.
The owner configuration SHA (provided separately as `--config-sha256`), selected
configuration and binary/source pins must be independently ratified. The owner
config pin is checked before parsing or executing its selected inspector;
config parsing does not grant custody. App IDs, public fingerprints, the appointed
public Root/Targets and actual existing custody paths remain prerequisites.

After those appointments and the separate custody grant are satisfied, review
only public data and private-file metadata, then use that exact returned
`expected_plan` in the owner's **private, unrecorded ordinary-user terminal**:

```sh
node scripts/catalog-recovery-vault-cli.mts review --for create --config /absolute/owner-recovery.json --config-sha256 RATIFIED_OWNER_CONFIG_SHA256
node scripts/catalog-recovery-vault-cli.mts create --config /absolute/owner-recovery.json --config-sha256 RATIFIED_OWNER_CONFIG_SHA256 --expected-plan RETURNED_SHA256 --name initial-backup
```

Enter and confirm a **nonempty** passphrase directly into age's terminal prompt;
do not send it to an agent, captured terminal, argument, environment variable,
configuration or recording channel. The wrapper never receives the phrase.
Standard age can generate and display a phrase on that private terminal if the
owner deliberately leaves the prompt empty; this is not an appointed recovery
identity or a recorded transport. Nonterminal invocation, Actions, UID 0 and an
`AGE_PASSPHRASE` environment override refuse before custody reads. The existing root-maintained `/usr/bin/stty` (resolved to a regular,
non-group-writable root-owned executable) snapshots a bounded nonsecret state
from a held `/dev/tty` descriptor. It restores and reads back that exact state
after age settles and before the API returns, including failed prompts. No
PATH or shell fallback, machine installation or secret input channel is used.
Interrupting a prompt kills and settles age, restores terminal state and leaves no completion
marker. A stale review refuses before custody content is read.

To recover after losing the primary files, retain the same independently ratified
public appointments and review **for restore**, which never stats or reads the
primary paths. Supply the independently retained ciphertext digest and a new
quarantine name; the same private terminal receives the secret:

```sh
node scripts/catalog-recovery-vault-cli.mts review --for restore --config /absolute/owner-recovery.json --config-sha256 RATIFIED_OWNER_CONFIG_SHA256
node scripts/catalog-recovery-vault-cli.mts restore --config /absolute/owner-recovery.json --config-sha256 RATIFIED_OWNER_CONFIG_SHA256 --expected-plan RETURNED_SHA256 --name recovered-quarantine --ciphertext /absolute/catalog.age --sha256 RETAINED_SHA256
```

`restoreCatalogRecoveryVault` requires the retained ciphertext digest, the separate
native identity or direct owner passphrase, and a newly prepared plan for the same
public appointments.
It accepts decrypted bytes only after age exits successfully, then verifies the
exact complete inventory and every private/public projection before writing any
recovered `.key` file. The create-only output is quarantine, never an installed
signing store. Interrupted or failed attempts retain their private directory and
cannot be overwritten; a successful durable `complete.json` is the sole local
completion marker. No completion marker grants activation or signing. Changed
appointments, wrong recipients, aliases, missing backups and corrupt ciphertext
refuse. Losing both primary material and the decryptable backup never regenerates
Root. Recipient rotation means a new encrypted copy of the same recovered keys;
TUF and App key rotation remain their existing separate authorities.

Ciphertext-only transport may use a shared recovery volume: its bounded
single-link/canonical read, retained digest and age authentication remain required,
while Linux 0700/0600 custody requirements apply only to plaintext working and
quarantine material. This adapter does not provision or copy to that storage.

Initial setup can back up the existing application and catalog keys together
before signed Root/Targets metadata exists. The separate
`initial-pre-payload-owner-passphrase-tty-v1` CLI profile uses the same vault
engine, age process, private terminal, key inspectors and durable recovery
boundary. Its public configuration replaces `configuration`,
`app_public_captures` and `public_inputs` with an independently pinned
`inventory: { "path": "/absolute/initial-inventory.json", "sha256": "REVIEWED_SHA256" }`;
the inspector, tool/private parents and complete distinct `key_paths` stay explicit.
It does not satisfy the existing catalog-only API or publication configuration.

The closed `initial-pre-payload-key-custody-v1` inventory binds repository ID,
source commit/tree, the initial creation receipt digest, exactly seven application
and six catalog TUF public keys, and the two measured App/installation/SPKI tuples.
Canonical Ed25519 public identities, complete roles and distinct material are
checked before private reads. Each key is reprojected with the pinned inspector
or captured App SPKI during backup and after authenticated decryption. Its
explicit `payload_credential: "not-created-not-covered"` describes an initial
snapshot, never completed production custody. Creating a payload credential later
requires a separately reviewed complete backup generation; this snapshot cannot
silently claim it is covered. No key is generated, signed, installed or appointed
by an inventory, parser or backup.

The create-only output is `initial-setup.age` plus its public completion receipt;
restore uses a fresh quarantine directory. Missing/extra/aliased roles, changed
inventory pins, wrong keys, foreign purpose and reused outputs refuse. The
existing catalog profile and `catalog.age` wire format remain unchanged. Both
profiles require the separate actual custody grant and local unrecorded passphrase
entry; fixture or initial-backup success supplies no Root or publication authority.

For that explicitly selected profile, `top_level_targets_profile:
"online-unchanged-authority-v1"` permits separately isolated Targets signing only
after a real authenticated prior repository exists. Its fixed body derivation
allows checked version+1 and strictly advancing expiry, bounded by 90 days and the
unchanged Root expiry; keys, delegations, publishers, paths and payload authority
cannot change. Omission keeps `offline-pinned-v1`. Initial bootstrap, expired
current metadata, delegation/key changes and Root maintenance retain their
separate authority. Application renewal has six isolated online roles; catalog
renewal has five. The component signer/context implementation does not activate
current controller factories: ratified profiles, exact-job custody, durable
coordinator transitions and actual protected observations remain required.

The maintained `portcove-release-tools` commands below prepare initial Root v1
and top-level Targets v1 with one private key per signing process. They use
existing Tough verification and fixed namespaces. They do not rotate keys,
provision custody or authorize publication; production invocation requires an
independent custody grant. The test-only
repository generator and consolidated `build-tuf` mode are not this custody route.

The four proposal/signing configurations are strict schema 1 JSON, resolve paths
relative to their configuration file and contain `generated_at` plus `output`. Public key inputs
are `{ "path": "public-key.json", "sha256": "<raw-file-sha256>" }` objects;
files contain only TUF `keytype`, `scheme` and `keyval.public`. Expected public
hashes and the Root body digest must be independently reviewed before custody
use. A digest reported by the proposal builder is a calculation, not approval.

Before these steps, each independently authorized custodian can use
`create-offline-key CONFIG` with exactly `{ "schema_version": 1,
"output_directory": "NEW_CUSTODIAN_DIRECTORY" }`. It creates a new directory,
one Ed25519 PKCS#8 `private.pk8` and its Tough-compatible `public.json` using the
existing aws-lc/Tough implementation; it reads no existing private key. Standard
output contains only public key ID/digest and fixed filenames. Unix output modes
are directory 0700/files 0600; Windows ACL protection must be independently
established and read back before production invocation. Existing or partial
output is never replaced or silently regenerated. Each role's custody location,
backup and public transfer are independently appointed at setup; the legacy
independent-custodian design must not consolidate its nine production creations
into one shared custody location. The approved single-owner replacement above
deliberately uses a different custody arrangement. No production key creation
is authorized by this implementation or its disposable tests.

For independently authorized recovery inspection, `inspect-existing-tuf-key
CONFIG` accepts exactly `{ "schema_version": 1, "private_key": "restored.pk8",
"expected_public_key": { "path": "appointed-public.json", "sha256":
"<independently-pinned-public-file-sha256>" } }`. It validates that public input
before reading the bounded, unlinked private input, then uses the existing Tough
key parser to compare its public projection. It emits only the public key ID and
`authority: "none"`; it generates no key, signature or output file. A missing or
different key refuses. This is a TUF key identity check, not an encrypted vault,
payload-key check, role appointment, backup restore qualification or permission
to read production keys. Existing custody and production gates still apply.

1. `prepare-offline-root CONFIG` reads **public files only**: exactly three
   `root_public_keys`, and separate `targets_public_key`, `snapshot_public_key`
   and `timestamp_public_key`, plus `expires`. It emits an unsigned Root proposal
   and canonical `signed_body_sha256`. The fixed policy is consistent snapshots,
   Root threshold two of three distinct keys and three distinct threshold-one
   top-level roles. Existing Root expiry remains at most 365 days.
2. Each custodian separately invokes `sign-offline-root CONFIG` with `root`, the
   independently approved `signed_body_sha256` and exactly one `signing_key`.
   The first custodian emits a partial; the second receives those public bytes
   and emits a complete quorum over the identical original body. Existing
   signatures are verified individually; duplicate IDs and foreign signers
   refuse. A partial keeps threshold two and cannot bootstrap a repository.
3. `finalize-offline-root CONFIG` accepts `root` and `signed_body_sha256`, with
   **no private-key field**. It verifies the original complete threshold and
   retains the exact signed bytes. No threshold-one verification projection is
   emitted or accepted as Root metadata.
4. The independent Targets custodian invokes `sign-offline-targets CONFIG` with
   `trusted_root`, `trusted_root_sha256`, `payload_key_registry`,
   `payload_key_registry_sha256`, `delegated_public_keys` containing public
   `releases`/`preview`/`stable` objects, `version: 1`, `expires`, and exactly one
   `signing_key`. It verifies the completed Root and fixed payload/delegation
   contract, including distinct online keys and the existing 90-day ceiling.
   It receives no online private key. Five separate `sign-tuf-role` jobs and
   keyless `assemble-tuf` then consume these exact public offline bytes.

Inputs are bounded regular files; linked/reparse ancestry refuses. Outputs use
CreateNew and file sync, with no overwrite or automatic retry. An existing or
partial output stays retained; inspect it and use a new explicitly reviewed
output path rather than silently replacing it. Config/public-key/private-key
limits are 64 KiB, signed metadata 1 MiB and the payload registry 256 KiB.
Custodian isolation, offline transfer/media, protected file ownership, backup and
restoration, final fingerprints and conditional execution authority still need
actual initial setup evidence. See the scoped
[one-key ceremony qualification](qualification/slice4-one-key-offline-ceremony-2026-10-21.md).

Routine role jobs use `portcove-release-tools sign-tuf-role ROLE CONFIG.json`,
where `ROLE` is exactly `releases`, `preview`, `stable`, `snapshot` or `timestamp`.
Each strict schema-1 configuration contains `context`, `signing_key` and `output`;
there is no other private-key field. Paths resolve relative to the configuration.
Snapshot and timestamp additionally require `signed_roles`, a directory containing
the public `releases.json`, `preview.json` and `stable.json` envelopes. Timestamp
also requires `snapshot.json`. Signed inputs must match the exact expected
version, expiry, content and upstream envelope byte hashes before signing.

The public context is a separate strict schema-1 JSON document with
`generated_at`, `trusted_root`, `offline_targets`, `payload_key_registry`,
`reconstructed_records`, `previous_repository`, `versions` and `expires`.
The last two objects use the six names `targets`, `snapshot`, `timestamp`,
`releases`, `preview` and `stable`, as in the existing builder. The caller must
independently ratify the root and complete prior repository; a path or digest
alone does not authenticate their provenance. The prior repository is bounded,
snapshotted and verified by Tough, including current expiration, before any
private-key read. Each online version must advance its authenticated prior floor.
Expired current state refuses routine renewal and needs separate recovery
authority. Offline targets bytes, version, expiry, delegations and payload registry
remain exact. Previously published releases cannot disappear or change.

`portcove-release-tools assemble-tuf CONFIG.json` consumes strict schema 1 with
only `context`, `signed_roles` and `output`. The public directory must contain all
five envelopes, including `timestamp.json`; extra files refuse. Assembly loads no
private keys. It verifies role signatures and exact content, then verifies the
assembled current repository through Tough. The output retains the existing
metadata/targets layout and `repository-manifest.json`, including authenticated
prior versioned metadata and immutable target bytes. Versioned path collisions
must be byte-identical; only timestamp and the derived inventory are replaced.
Historical envelopes may be expired, but are signature/hash verified and never
serve as current freshness evidence. Existing file/byte limits bound retained
history; exceeding them refuses rather than deleting it. Routine root/top-level
rotation is outside this unchanged-anchor path.

For the bounded beta, Stable signing and assembly require both the authenticated
prior Stable target map and the new map to be empty. This only renews an unchanged
empty map; it cannot promote a release or erase a populated Stable channel.
Each signer reports its role/output digest and `authority: "none"`; assembly
reports exact public file identities. Repeating exact output reuses it; a changed
existing output refuses. Payload signing remains a separate operation.

`portcove-release-tools prepare-tuf-renewal CONFIG.json` prepares public inputs
for metadata-only renewal. Its strict schema-1 configuration has `generated_at`,
`trusted_root`, `previous_repository` and `output`. The caller independently
ratifies the root and authenticates complete current public feed/readback
provenance. The frozen generation time supports identical retries; it cannot
override expirations. The tool verifies current TUF signatures and expiration,
the unchanged offline anchors and retained signed history before returning a
plan. Expired current state requires separate recovery. It reads no private key.

The prepared context preserves all record bytes and advances the five online
versions by exactly one, with increasing expirations within the existing caps:
48 hours for timestamp, seven days for snapshot/Preview/Stable and 90 days for
releases. Targets version/expiry and root/targets bytes remain unchanged. Stable
remains empty. The output supplies the same context to the existing isolated
role jobs and keyless assembler; it allocates no application version, candidate
or semantic approval. Signing and publication remain later protected operations.

`renewal.json` binds the current and next versions/expirations, frozen clock,
root/targets digests, prior timestamp/snapshot digests, unchanged record identities
and exact prior public component inventory. Versions in this descriptor are
canonical positive decimal strings, preserving TUF's full `u64` identity in
JavaScript; TUF/config versions retain their existing numeric representation.
Descriptor digests use compact JSON with sorted object keys and no terminal
newline. The prior component digest covers sorted `{path, bytes, sha256}` entries
for public `metadata/**` and `targets/**`. It excludes the internal
`repository-manifest.json`, which is derived locally and is not a required public
endpoint. Shared-site generation identity is separate. A digest or persisted
plan does not authenticate provider provenance or grant an effect.

The unchanged reconstruction step still requires the complete retained inventory
history and protects existing immutable releases. Role isolation changes local signing
custody, not allocation, qualification, controller, publication or platform
acceptance. The same file/byte/record, expiry, distinct-key and atomic-output guards
apply. Schema 1 remains available for existing explicit all-key fixtures.

Production credential provisioning, GitHub Pages publication, endpoints, updater
activation, and publication permission remain with their protected owners. A build
configuration is an unauthenticated controller input and must stay outside the
repository when it contains private-key paths.

Payload verification streams at most 2 GiB; key and signature metadata are bounded
to 16 KiB. Only prehashed Minisign signatures emitted by current Tauri tooling are
accepted. The Rust verifier has no private-key or publication operation. The
workflow retains public keys, exact packages, inventories, patches and observations
for one day; it never uploads private keys or changes published releases. Download
required evidence before expiry. Deterministic fixtures, package inspection,
installed execution, physical devices and human observations remain distinct.

## Version authority

The release version must match in exactly three places:

- `[workspace.package].version` in `Cargo.toml`;
- `version` in `apps/desktop/package.json`;
- `version` in `apps/desktop/src-tauri/tauri.conf.json`.

After changing them, run Cargo once so the workspace package entries in `Cargo.lock` are refreshed (including the unpublished release verification tool). A release tag is always the exact version with a `v` prefix, such as `v0.1.0` or `v0.2.0-beta.1`.

`scripts/check-release-metadata.mts` verifies those versions, the tag, package manager pin, repository/license metadata, Tauri identity, and the required master/runtime/platform brand assets. It also requires one created local `main` Tauri window, scopes the default capability to that window, and uses Cargo's metadata graph to keep the declared qualification-only features out of both the transitive default Desktop feature set and always-enabled dependency features. The production Vite build independently rejects development scenarios and test fixtures from emitted assets. Local packaging derives its default version from that check and rejects an explicit mismatch.

The offline `pnpm --dir apps/desktop release:policy` utility accepts `classify`,
`select` or `propose` followed by one JSON input file. It shares the existing Node
tooling workspace and maintained SemVer dependency; it is not renderer code.
Classification defaults to Preview, including suffix-free 0.x and unapproved
final versions. Stable requires separate explicit production eligibility for a
final version at or beyond 1.0; approved finals are also eligible for Preview.
Selection checks separately supplied eligibility and optional target/current
version, rejects equal-precedence ambiguity, and orders by SemVer rather than date.
Build metadata alone never requests reinstallation.

Proposals require matching frozen source/review commits, complete published
version history, and an explicit change/compatibility classification. They reject
stale bases, implicit prerelease finalization, published precedence reuse, and
compatibility breaks without the required version change and migration notes.
A proposal does not allocate a version, edit metadata, authenticate its input,
grant production approval or publish a release. Its caller must establish input
authority. Existing production publication remains separately protected; a
proposal cannot activate that procedure. Download selection uses the same policy.

`pnpm --dir apps/desktop release:prepare REPOSITORY INPUT.json` accepts
`classification` and `published_versions` using the proposal schema. It reads
only the frozen commit, updates the coordinated Cargo/Desktop/Tauri versions and
workspace lock entries in a temporary index, and creates a prepared child commit.
It leaves the working files, real index, current branch and public tags unchanged.
Two custom refs, `refs/portcove/prepared-versions/vVERSION` and
`refs/portcove/prepared-commits/SOURCE`, are created in one Git transaction. Their
commit binds the source, tree and classification digest. Identical retries return
that same commit; conflicting intent, version reuse and incomplete receipts fail
closed. Prepared bytes require their own validation and review before publication.
Receipt verification holds both Git ref locks, so concurrent publication of the
receipt pair cannot be mistaken for an incomplete allocation. Lock acquisition
is bounded to one second per Git attempt; a still-locked coordinator fails and
can be retried after the owning operation finishes. Git object creation uses
hard links to preserve existing objects during concurrent identical writes.
The coordinator filesystem must support that operation; unsupported filesystems
fail instead of switching to overwriting existing objects.

Allocation is serialized within one coordinating Git repository and its linked
worktrees. These immutable preparation receipts are not a live roadmap or a
production authorization. A future protected controller must retain that single
coordinator, refresh the complete published inventory, and validate input
authority; separate clones do not constitute a global allocator. The tool neither
pushes refs nor chooses credentials. Never delete a receipt to recycle a version.

`node scripts/release-coordinator.mts INPUT.json` is the deterministic decision
boundary in front of that preparation operation. It requires a complete fresh
canonically ordered publication inventory, exact candidate commit/tree, matching reviewed
classification and accumulated-change digest, exact base revision, controller
revision, pause/capacity state, and any active
prepared candidate. Routine Preview work is coalesced to one opportunity per 24
hours; documentation-only, unchanged, and already-published snapshots are
skipped. Urgency bypasses only that cadence, while Stable remains subject to the
separate production-eligibility policy. An active candidate always finishes or
holds first; a newer merge is recorded for the next opportunity and never
cancels the frozen run. Lost reservations fail closed instead of allocating a
replacement version.

The planner emits a content-digested action and exact workflow/preparation
identities. Active-candidate actions retain the frozen intent, phase, recovery
counters, and bound release run in that digest. The read-only `Release coordinator rehearsal` workflow serializes a
manual default-branch invocation without cancellation, rejects a controller
revision mismatch, and retains the plan for seven days. Neither layer performs a
GitHub, Git, build, signing, feed, or publication mutation. A future activated
controller must retain the prepared refs and planner state in one coordinator,
bind the existing reusable qualification and Release workflow to the prepared
commit, and persist attempts in existing workflow/issue records.
Two transient retries and three substantive repair attempts are the fixed
initial bounds; exhaustion, missing authority, the publication pause, or free
capacity refusal or an invalid spending boundary produces a hold. Production dispatch, signing, release and
Pages/feed permissions remain disabled pending #534. The checked-in fixture tests
are nonproduction evidence, not proof that a subscription task or production
credential path is active.

### Configuration-held fixed-controller source admission

`.github/workflows/application-update-production.yml` contains the complete fixed
controller. Its secret-free admission job starts only with the existing admission
configuration and exact configured revision/ref; every downstream role retains its
own authenticated admission. The separate automatic wake starts only with its
existing wake configuration. Neither source installation activates these settings,
credentials, protected environments, signing or publication. See the
[current controller integration](qualification/slice4-complete-controller-integration-2026-10-21.md).

The source-admission bootstrap uses three **public identity**
variables: `PORTCOVE_CONTROLLER_REVISION`, `PORTCOVE_CONTROLLER_REF`, and
`PORTCOVE_CONTROLLER_ADMISSION`. None is configured or authorized by this change.
The first two bind an exact commit and a protected tag in the
`refs/tags/portcove-production-controller-` namespace. No particular production
tag or principal is selected here; the exhausted disposable canary is excluded.
The complete-controller JSON policy has exactly `schema_version:2`,
`mode:"bounded-application-release"`, `execution_ref`, `revision`,
`workflow_sha256`, string `actor_id`, `authority_configuration_sha256` and
`grant_sha256`. Historical schema-1 admission-only records cannot authorize the
complete role operations. Its ref and revision must match the bootstrap variables.
The workflow digest is SHA-256 of the
reviewed workflow's raw bytes. Policy must come from separately ratified operator
configuration, never candidate data or a dispatch input.

Before checkout, the workflow compares repository ID/name, event, protected tag,
source/workflow commit, workflow path/ref and first-attempt identity. It checks
out that exact workflow commit with credential persistence disabled. The
dependency-free `scripts/production-controller-admission-cli.mts` then also validates
the fixed source digest, configured actor, triggering actor, run, job and hosted
runner identity. Its CLI accepts no candidate or policy-file arguments and reads
only the fixed workflow file through one bounded regular-file handle.
GitHub's [default execution variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
are the source of these execution facts. The gate assumes this bootstrap runs
from trusted workflow source; arbitrary candidate code can forge a local process
environment, so its output is not a transferable authorization token.

Contract fixtures execute bootstrap refusal paths and the CLI without installed
dependencies. They establish source admission only. `GITHUB_REF_PROTECTED=true`
does not prove immutable tag rules, absence of bypass actors or production secret
isolation. Actual platform enforcement must be independently provisioned and
proven before any secret-bearing job executes. Installed role sources are not
provider enforcement or grants. Actual host and issuer qualification, protected
configuration, custody, eligible coordinator state and real public recovery
proof for the selected application release profile remain under #534. The first
Windows beta still requires its actual Windows/shared proof; Linux application
recovery remains required for the retained broader profile and subsequent Linux
release. The existing canonical owner packet binds the final reviewed
controller, configuration and exact protected grant before use.

### Durable local coordinator checkpoints

The [coordinator and initial empty-feed implementation receipt](qualification/slice4-534-coordinator-and-initial-feed-2026-10-20.md)
describes the request-bound continuation, automatic classification writer and
explicit no-prior bootstrap context, including the remaining runtime joins and
ungranted production prerequisites.

`await checkpointReleaseOpportunity(repository, expectedPrevious, input)` in
`scripts/release-coordinator-state.mts` persists the existing planner's validated
input and returns its plan plus an exact checkpoint commit. It executes no plan.
Use `null` only for explicit first initialization; subsequent calls supply the
last checkpoint identity. `await recoverReleaseOpportunity(repository, expected)`
recovers that exact snapshot only if its current ref and prepared receipts still
agree. Callers must independently authenticate the live inventory, controller,
checks and publication facts before recording them. Persistence does not
authenticate supplied evidence or grant execution/publication authority.

One retained Git repository and its linked worktrees share
`refs/portcove/release-coordinator-state`. Parent-linked commits retain canonical,
bounded snapshots without changing a checkout, index or branch. State CAS and
both existing prepared-version/source receipt verifies share one Git transaction.
The transaction inspects ref types while Git holds those locks, aborting symbolic
aliases before commit. Preparation notes are strings, so canonical checkpoint
serialization preserves their exact intent bytes.
Identical lost-response retries verify that complete receipt set; stale preimages,
missing or conflicting allocation refs and locked state refuse. Separate clones
are separate coordinators, so this is not a global or hosted reservation service.
The activated controller must retain the one repository; it must never treat a
lost initialized ref as a new empty allocator. Existing immutable allocation refs
remain in place after completion.

Admission binds the preceding preparation plan, controller identity and exact
preparation intent. Active source/tree, prepared commit/tree, version and intent
stay frozen. Recorded phase advances refuse skips; they do not establish actual
qualification or execution. Failed candidates
keep their failure classification until a planned bounded retry/repair restarts
at `prepared` with no run. Counters cannot decrease or jump. A recorded run can
change only through that recovery. Clearing a `promoting` candidate requires the
matching version/source in the independently authenticated publication inventory;
the tool verifies its supplied shape, not remote publication. Pause/capacity
snapshots retain the active candidate. Recovering an old snapshot does not renew
its inventory freshness for a future action.

An allocating caller may copy that preceding input's whole `opportunity` into
the optional `active_candidate.frozen_opportunity`. The state transition requires
canonical equality with the preceding checkpoint and the active original
source/tree. Once present it cannot be changed or removed; once absent it cannot
be added to an already active reservation. Resume/retry/repair plans include it
only when present, so legacy serialized plans and checkpoint inputs retain their
existing bytes/digests. Legacy absence is not normalized to `null` or reconstructed
from a later queued opportunity. The existing 64 KiB checkpoint bound still
applies to the whole duplicated snapshot. This preserves a consistency record,
not classification authority or a recurring personal approval requirement.

This supplies nonproduction local persistence/refusal controls for #534. Trusted
execution/principal enforcement, producer-job/attempt/artifact binding, isolated
candidate runners/caches, protected remote durability, custody, signing/feed
activation and actual public recovery proof for the selected release profile
remain separate. The Windows-only scope does not supply missing Windows proof
or complete deferred Linux acceptance.

### Bounded no-spend attempt eligibility (Slice 4)

Coordinator input schema 2 replaces the legacy `free_capacity_available` Boolean
with `controller.capacity_attempt`. Schema 1 remains unchanged for historical
replay, including serialized plan digests. New admission uses schema 2 and never
sets the legacy Boolean to bypass an unknown allowance. `release-capacity.mts`
reports eligibility separately from availability/headroom (always `unknown`) and
reservation (`none`). The selected account-wide $0 Actions stop, public standard
runners and pinned resource ceilings are a spending boundary, not positive
headroom. Each operation must establish its own exact result; no successful
operation grants availability for a subsequent effect. Source/configuration loss,
revocation or boundary drift refuses, and unrelated admission holds remain holds.

`release-capacity-operation.mts` is an inactive caller-owned library, with no CLI,
credential discovery, dispatch, upload, signing or publication implementation.
An already admitted caller provides one exact effect against an existing frozen
reservation. Its pending intent is checkpointed before execution, then the supplied
boundary and exact pending ownership are checked again. Completed receipts are
validated before mutation, serialized and drained before outcome publication.
Capacity refusal retains its bounded evidence; all other failed or missing-result
responses remain ambiguous. A failed checkpoint response is not proof of no
remote effect: the last durable pending intent continues to block.

Existing readback must resolve the exact checkpoint and operation identity before
another attempt. Recovery preserves completed effects and failure evidence;
`effect-not-applied` contradicts any retained completed effect. The existing
portable checkpoint retains up to 32 resolved prior operations for the current
candidate; transitions refuse a dropped/rewritten or overfull summary. This
preserves fresh sparse remote recovery without requiring older grandparents. An
intervening operation cannot erase completed effects or reset same-operation retry
limits. Ordinary coordinator recovery must consume its existing retry/repair
counter before repeating a resolved failed operation. Phase and counters never
advance merely because capacity evidence was recorded.

The fixed ratification and boundary observations must come from independently
admitted provenance. Hash matching and persistence alone do not authenticate that
provenance, prove provider enforcement or detect an unreported setting change.
The configuration owner must revoke ratification before changing the account,
spending stop, runner class or resource policy. Protected remote pending durability,
exclusive live executor/readback ownership, final runnable source/digest, eligible
candidate and exact protected execution grant remain separate activation gates.
See the [canonical Slice 4 packet](qualification/slice4-production-authorization-packet-2026-10-18.md)
for the selected boundary, retained provider observation and resource estimate.

### Inactive remote checkpoint transport

`publishPreparedCoordinatorCheckpoint` in `scripts/release-prepared-transport.mts`
connects the existing deterministic version preparation to remote object custody
and then to the existing checkpoint CAS below. Its read-only export reconstructs
the four authorized version edits (`Cargo.toml`, `Cargo.lock`, desktop package
metadata and Tauri configuration), verifies the sole source parent, canonical
intent, actors/date and exact raw commit identity, and refuses extra tree edits.
Lazy fetching is disabled; missing application objects in sparse recovery refuse.

The fixed repository's source commit/tree must already exist remotely. The
adapter stages only four bounded blobs, their overlay over that base tree, and
the exact prepared commit. It verifies returned OIDs and fresh commit readback
before using the unchanged checkpoint/ref transaction. Replay creates no objects
or refs when the same complete state already exists. Lost object acknowledgments
require exact readback; unresolved outcomes retain original errors/known OIDs and
stop before later effects. No blind retry, alternate allocator or ref writer is
introduced. Local allocation and partial immutable remote objects remain retained.

Local export is capped at 64 Git reads/120 seconds, 8 MiB per blob and 16 MiB
total; raw commits are capped at 128 KiB. Remote staging has 32 requests/120 seconds
plus 30 seconds for failure collection. The injected synchronous transport must
itself enforce per-request time/response bounds. Its separately ratified identity,
credential and execution boundary are still required; no CLI/default credential
lookup or production activation is added. Object custody is not admission,
semantic acceptance, qualification or an execution grant.

`exportCoordinatorCheckpoint(repository, expected)` exports the existing journal's
exact blob, tree and commit from a caller-owned bare coordinator. It validates
physical UTF-8 and canonical state bytes, fixed commit metadata, the preceding
transition and the complete preparation receipt pair. The caller establishes
ownership of that path; bare status alone supplies no authority.

`publishCoordinatorCheckpoint(repository, expected, configuration, { api })` in
`scripts/release-coordinator-remote.mts` supplies an inactive transport seam.
The caller injects a bounded API transport and separately ratified configuration
`{ schema_version: 1, namespace }`. There is no default transport, configured
production namespace, CLI or workflow activation. Configuration is a destination,
not an execution or publication grant. Production integration must enforce the
fixed controller, principal, protected refs, fresh accepted inputs and isolation
before constructing that caller.

The adapter fixes the repository identity to `boburning/portcove` / `1354613114`.
The namespace selects one coordinator state branch and two preparation tag
namespaces. An initialized previous checkpoint and exact remote source/prepared
application commits are required. Application-object transport and one-time
initialization remain separate reviewed operations. The adapter uploads only the
checkpoint's inert objects and compares each returned Git identity. One
[atomic GitHub ref update](https://docs.github.com/en/graphql/reference/git#updaterefs)
compares the state preimage and creates or verifies both immutable receipts;
updates use `force: false` and retain completed allocations. Exact observed
replay performs no upload or ref mutation.

The cooperative API budget is 16 requests and 120 seconds, plus 30 seconds for
post-mutation collection; injected calls must have finite timeouts (the existing
GitHub runner defaults to 15 seconds). A possibly committed CAS receives one
fresh readback. Unknown, conflicting or unavailable readback preserves the local
checkpoint and failure evidence for explicit reconciliation, without automatic
retry, rollback or reallocation. An observed final state identifies that state;
it does not establish which concurrent actor applied it.

Isolated tests exercise actual Git object identities and the existing bounded
API adapter through an injected fake provider. Production qualification still
requires platform proof of exact object reproduction, existing tag receipt
verification with unchanged OIDs, principal/ref enforcement and recovery. This
transport supplies neither authentic producer facts nor signing/feed authority.

### Bounded remote checkpoint recovery

`recoverRemoteCoordinator(parentDirectory, configuration, { transport })` in
`scripts/release-coordinator-recovery.mts` reads the existing checkpoint through
an explicitly configured transport. It pins `github.com`, repository numeric
and node identities, and exact qualified refs. Ref snapshots use that immutable
repository node; object reads reproduce the exact Git hashes obtained from it.
No production namespace, credentials, CLI or workflow is configured by this seam.

Recovery collects only the current and immediate previous checkpoint commits,
their one-file trees and bounded canonical `state.json` blobs, plus the active
source/prepared commit bytes. It performs no Git fetch, pack import, checkout,
application-file download or candidate execution. REST commit fields omit raw
headers, so reconstruction is accepted only when the resulting complete object
hash equals the expected identity. Supported unsigned commits use canonical UTC
timestamps; signed commits additionally require the complete matching payload
and signature with reproducible header folding. Unsupported forms refuse rather
than guessing. Reproducing a signed object's bytes does not authenticate its
signer or grant publication authority.

The transport bounds each response before parsing to 256 KiB and 15 seconds.
Collection has at most 20 requests and a cooperative 120-second deadline; one
in-flight bounded call may finish after it. Two complete state/paired-receipt
observations must agree after object collection. Changed, incomplete or missing
observations refuse before creating a local repository.

Only then does recovery create a fresh bare directory under the caller-owned
parent. Shared journal validation checks canonical bytes, the preceding
transition and raw preparation intent before one transaction creates the state
and paired local receipt refs from zero. Import accepts at most 16 verified
objects, 128 KiB each and 1 MiB total. Hooks and lazy retrieval are disabled.
Failures retain the owned directory and identify its path, checkpoint and phase.

The result is explicitly `recovery-only`: older checkpoint history, application
trees/files and complete historical allocation receipts are unavailable. It can
recover and export this exact snapshot; it is not a source checkout or a new
allocation permission. Later allocation still requires complete independently
authenticated inventory and the existing remote CAS/collision checks. Remote
state may advance after the observations; any later mutation must supply its
exact preimage. Fake-provider tests prove this sparse recovery contract, not
protected GitHub execution, principal enforcement or production recovery.

### Inactive bounded trusted assembly

`assembleTrustedRelease(ownedRoot, inputRoot, request)` in
`scripts/trusted-release-assembly.mts` supplies an assembly interface for a future
fresh trusted controller. It loads the complete package policy only from its
fixed trusted checkout. The caller must independently authenticate the supplied
source/tree and expected file sizes/hashes; this function establishes equality,
not the authority of those supplied inputs or producer declarations.

Inputs contain exactly the complete policy matrix, each platform checksum
manifest and producer declaration. Only those known files are opened: no
unbounded input traversal, extraction or candidate code runs. Limits are 64
files, 512 MiB per package, 2 GiB total and 64 KiB per metadata file. Regular
unlinked leaves are checked before opening and again through the handle;
nonblocking/no-follow flags are used where supported. Bounded streaming copies
check growth, mutation and exact hashes into a newly created owned staging area.

The existing reconciler produces a new aggregate, checksum manifest and
inventory from that bounded private stage. Final package bytes are rehashed
against both the independently supplied identities and reconciled inventory.
Retries create distinct owned results and preserve earlier outputs; failures
retain the identified partial directory. The cooperative assembly deadline is
ten minutes, checked at bounded streaming operations; it is not a hard deadline
for filesystem completion or the existing bounded reconciliation reads.

Results identify the role as `package-aggregate-assembler`. Authenticated
assembler and original compiler identities remain null. SBOM finalization and
release authorization remain `not-evaluated`. There is no workflow, upload,
attestation, signing, installation or publication activation. In particular,
running the retained broader-profile finalizer in a controller checkout would
evaluate its Linux release gate against that checkout; this interface does not
do so or bypass #706. The Windows-only profile instead uses its source-bound
non-authorizing audit assessment; that assessment grants no signing or
publication authority and does not waive shared scan failures. A future
finalizer still needs independently authenticated exact
candidate/scan/publication evidence, applicable qualification, authenticated
producing run/attempt/job and exact artifact/attestation binding through the
existing protected architecture.

### Bounded artifact-to-aggregate integration

The existing Windows/Linux profile below retains its exact broader package and
evidence contract. The first Windows-only beta instead requires the additive
`initial-beta-windows-x86_64-v1` path to be delivered, independently reviewed and
qualified through the same machinery; its implementation and protected
source/resource/activation holds are not satisfied by choosing a name or omitting
Linux artifacts from the broader profile.

The trusted `initial-beta-win-linux` profile declares exactly six distributions:
Windows x86-64 current-user NSIS and CLI ZIP; ordinary Linux x86-64 AppImage,
DEB, RPM and CLI tar.gz. NSIS/AppImage retain application-updater ownership;
DEB/RPM retain package-manager ownership. The complete repository package policy
is validated before selecting this fixed subset; missing selected packages refuse.
Default `full` builds and qualification retain all four platforms and ten packages.

The Release identity job validates the named profile and emits its fixed build
matrix. Reusable qualification binds the same profile into the plan digest and
requires all applicable Windows/Linux checks. The reduced profile is available
only to explicitly forced Release qualification, not PRs or nightly qualification.
The result gate requires macOS jobs to be skipped for that profile; it still
requires every applicable producer. An expected-full consumer refuses a reduced
qualification plan. Assembly schema 2 and ratified admission configuration schema
2 bind `release_profile`; historical schema 1 still means the complete full matrix.
Provider archive selection, verified aggregation, aggregate attestation and download
guidance consume the selected inventory. Selecting a distribution profile grants
no execution, signing, publication, native acceptance or catalog authority.

Release workflow uploads use immutable attempt names:
`release-build-<platform>-<run-id>-<attempt>` and
`release-{final,attestation-metadata,publication-metadata}-<run-id>-<attempt>`.
Uploads refuse overwrite and request seven-day retention. Downloads select the
same run and attempt; reconciliation requires matching declared producer lineage.
A partial rerun cannot silently borrow a prior attempt's builds. Verified local
staging still uses `release-build-<platform>` directories. Artifact names do not
authenticate the original compiler or establish its job/attempt identity.

Rehearsal and draft publication no longer delete run artifacts: neither proves
the downstream controller has durable custody. Provider expiry remains the
fallback; earlier deletion requires a separately verified terminal handoff and
exact artifact IDs. Each attempt adds its build archives, aggregate and metadata
to the seven-day storage window. This retention request supplies neither space
nor a reservation: admission remains a bounded attempt under the ratified $0
stop-usage boundary, with availability/headroom Unknown. Provider refusal stops
the attempt and preserves available effects for explicit recovery.

`assembleReleaseArtifacts` in `scripts/release-artifact-assembly.mts` connects
the existing complete Release run evidence collector, opaque artifact transport,
private staging and the full-policy assembler. Callers supply independently
accepted run/source/tree/workflow identities, the complete expected file matrix,
and one exact artifact ID, byte count and SHA-256 per platform. These inputs are
frozen before asynchronous reads. Complete provider inventories must match the
selected objects before downloading and again before aggregate creation. Run
identity and selected artifact metadata must remain unchanged. Run-level API
objects still leave original producer jobs and attempts unknown.

`scripts/github-binary.mts` pins transport to `github.com` and enforces byte and
time limits in the subprocess before returning opaque bytes. Release downloads
are bounded by their accepted byte counts, at most 512 MiB each, 2 GiB in total,
and 120 seconds per download. Collection and assembly have a cooperative
15-minute overall deadline. Audit reuse shares this transport while retaining
its existing 8 MiB compressed and 15-second request limits.

`stageReleaseArtifact` checks the archive digest after taking private buffer
custody. Shared raw ZIP32 preflight bounds central/local records and metadata
before inflation. ZIP64, multipart archives, unsupported extensions, links,
unlisted paths and duplicate or alias entries refuse. Only flat filenames and
`release-upload/` filenames are accepted. Complete expected inventory and
declared per-file sizes must match before output creation or inflation. Actual
expanded size, CRC and independently expected SHA-256 must then match. Each
platform directory is new; existing directories refuse, and partial failures
retain their identified private path. No candidate code or package is executed.

This integration creates a new local aggregate, without upload, attestation,
signing or production activation. Injected transports are explicitly labelled.
Actual fixed-controller execution, independently authenticated admission inputs,
the assembler's own identity, immutable upload and verified attestation binding
remain required. Linux release authorization, SBOM and native qualification
remain separate and unevaluated.

### Inactive assembler job identity verification

`verifyAssemblerJobIdentity(token, expected, { transport })` in
`scripts/assembler-job-identity.mts` verifies a GitHub job token's identity. It
does not request a token, execute a workflow or establish code execution,
artifact production, protection enforcement or permission. The caller supplies
independently expected controller configuration and invocation facts; there is
no default audience, subject, principal, controller revision/ref or transport.
The subject must match the separately ratified actual GitHub subject format.

Verification uses GitHub's existing [OIDC issuer and RS256
keys](https://docs.github.com/en/actions/reference/security/oidc), with a fixed
HTTPS JWKS location, no redirects, 15-second collection and a 128 KiB pre-parse
response limit. Tokens are bounded to 16 KiB. Unsupported JOSE key selection,
noncanonical encodings, missing/ambiguous/unsupported keys and invalid signatures
refuse. Exact signed issuer, audience, subject, repository, actor, direct
controller workflow/ref/revision, run/attempt, event and hosted-runner claims
must match. Expiry/not-before/issued-at checks use the current clock without an
expiry extension; expiry is rechecked around API calls. Raw bearer tokens are
neither returned nor persisted.

The bounded read-only GitHub API transport pins `github.com` and collects the
complete current attempt job inventory, at most 1,600 unique jobs. A signed
`check_run_id` must identify exactly one API `check_run_url`; its corresponding
numeric job ID is retained independently. They need not be equal. The fixed job
name additionally checks the expected assembly role, never replaces that signed
identity association. A fresh numeric-job read must still match the run,
attempt, controller revision and check-run URL while in progress, and the run
identity is bracketed. API limits are 20 requests, 120 cooperative seconds and
2 MiB per response, with a 15-second subprocess collection bound.

The receipt says `oidc-job-identity-only` and `authority: none`. Injected key/API
readers are labelled `injected-provider`. Protection enforcement, actual code
execution and artifact production remain explicitly unproven. The helper does
not assume a signed protection claim establishes platform ref/bypass controls.
An attempt-two fixture proves matching only; current controller admission still
permits attempt one and grants no retry authority through this helper.

Actual producer binding still needs the fresh fixed trusted job to assemble the
new aggregate, capture its own identity, upload a new immutable artifact, bind
its exact artifact/package identities through existing attestation, and verify
that attestation's workflow, subjects and claimed job association. Candidate
input authority, isolation, strict Linux/SBOM/native qualification, custody,
production permissions and the specifically authorized proof remain separate.

### Inactive aggregate attestation binding

The [held aggregate workflow](qualification/application-update-production.aggregate.yml)
connects existing reservation recovery, assembly, a new immutable upload, fresh
own-job binding and an isolated attester. It is outside `.github/workflows` and
keeps literal holds on all new jobs. `production-aggregate-steps.mts` is its
bounded transport/orchestration adapter; it never admits its input authority or
allocates/advances a reservation. The read-only input gate acquires bounded
provider facts but always holds. Independent candidate/file-matrix acceptance,
authenticated fresh classification/pause/capacity sources and production
configuration remain missing. The
[dated authorization packet](qualification/slice4-production-authorization-packet-2026-10-18.md)
records exact proposed permission scopes and the remaining owner decisions.
Merging this inert preparation cannot activate the runnable admission-only
workflow or grant protected execution/signing/publication.

### Frozen source consistency

`collectReleaseSourceChanges` in `scripts/release-source-changes.mts` collects the
complete provider `base...source` commit comparison with explicit ancestry,
stable totals, unique identities, fixed-path pagination and source closure. It
does not use the comparison endpoint's bounded first-page file list. Each
returned commit is reconstructed through the existing raw Git validator. Two
nontruncated recursive tree inventories are reconstructed, including every
subtree, under their exact original commit/tree identities. Symlinks and gitlinks
remain opaque modes/OIDs; nothing is checked out, followed or executed.

The versioned net tree delta uses SHA-256 over UTF-8 `JSON.stringify` bytes with
no trailing newline. Its object keys, in order, are `schema_version:1`,
`scope:"portcove-release-net-tree-delta-v1"`, `base_commit`, `base_tree`,
`source_commit`, `source_tree`, `changes`. Changes are sorted by UTF-8 path bytes
and contain `path`, `before`, `after` in that order. Each side is `null` or an
object with `mode`, `type`, `oid` in that order. Changed directory entries are
included; renames are deletions/additions. No locale-sensitive ordering, path
normalization, rename inference or semantic classification enters this digest.
It binds the accumulated final-tree difference, not all intermediate touched
paths, meaningfulness, documentation-only status, urgency or compatibility.

The input gate interprets a frozen classification's `change_set_sha256` with
this encoding only when its explicit `change_set_scope` equals that scope. It
requires the frozen opportunity and classification digests to match the acquired
facts, and associates the already retained preparation proposal's source/base,
version/change/channel fields and compatibility/migration notes. It neither
reallocates a version nor invents historical publication input for a retry. A
later coalesced opportunity cannot replace this original classification. Missing
frozen data or an opaque legacy hash remains a hold; mismatched facts refuse.
Source/writer authority is still independently required.

Collection permits at most 20 reads within two minutes, 16 comparison pages /
1,600 commits, 5,000 entries per tree and the unchanged 128 KiB raw-object bound.
Each caller must also bound provider response/subprocess bytes; the input gate
uses its existing 2 MiB/15-second runner. Truncated, oversized, unsupported empty
trees, escaping pagination and incomplete ancestry refuse. The existing overall
admission budget and literal workflow holds remain unchanged.

Signed Git commit reconstruction permits bounded known offset/header forms
whose actor epoch/identity matches REST and whose complete bytes hash to the
expected object. A terminal signature continuation is accepted only if that
exact hash matches. The provider's `verified` marker is never authority. The
retained four-case legacy planner oracle is fixture-scoped; the live read-only
`903f25e...799da57` comparison proves Git/API compatibility and consistency only,
not classification, controller execution or release authorization.

`prepareAggregateAttestation` in `scripts/trusted-aggregate-attestation.mts`
prepares inputs for the existing pinned `actions/attest` action. The reviewed
fixed workflow must call it after `assembleReleaseArtifacts` and an actual new
immutable upload, passing the complete independently accepted candidate artifact
IDs. The count must equal the full package-policy platform matrix. The new ID
must differ from every candidate ID and belong to the distinct controller run.

The helper checks exact numeric artifact API identity, name, source, size,
provider digest and nonexpired state; downloads opaque bytes within the accepted
size and 120 seconds; and verifies complete ZIP members against the accepted
package hashes and independently reconstructed aggregate checksum manifest.
It then invokes fresh signed own-job verification itself and rechecks artifact
identity and token expiry. Caller-supplied identity receipts cannot replace
that invocation. The bounded 64 KiB predicate binds controller revision/ref,
run/attempt, distinct numeric job/check-run IDs, new artifact bytes, complete
candidate inputs and output members. No token enters the predicate. Injected
providers produce an explicitly labelled predicate that the protected consumer
path refuses.

`verifyAggregateAttestation` takes independently expected controller, candidate
and artifact facts plus bounded opaque archive and offline bundle bytes. It
checks archive members, copies inputs into a new private directory and invokes
existing `gh attestation verify`, with exact signer workflow/controller digest,
controller source digest/ref, GitHub OIDC issuer, hosted-runner policy and custom
predicate type. CLI output is limited to 1 MiB and 30 seconds; the bundle to
512 KiB. It requires one verified result, a timestamp, exact signed certificate
repository ID/controller/run identity, subject digest/name and complete predicate
association. These controls follow GitHub CLI 2.102.0 and its Sigstore Go 1.3.0
verified-result schema; unsupported result shapes refuse.

The certificate identifies the attester. The assembler's job association is a
claim from the reviewed fixed workflow's fresh identity verification, not a
numeric job inferred from that certificate. Archive/member equality, authenticated
aggregate assembly and original compiler provenance remain distinct. This module
requests no OIDC token, creates no attestation and activates no workflow or
permission. Actual hosted assembly/upload/attestation execution, trusted input
admission, isolation and production authority remain required. Linux release
authorization, SBOM and native acceptance remain unevaluated. Failed consumer
verification retains its identified private copies. Synthetic CLI fixtures test
the association controls, not cryptographic or hosted attestation success.

### Read-only release-run evidence

`node scripts/release-run-evidence.mts REQUEST.json` collects bounded read-only
API evidence for an exact completed current `Release` run and attempt. The
request contains only schema version `1`, numeric `repository_id`, `run_id` and
`attempt`, and independently reviewed `revision`, `tree` and `workflow_sha256`
hexadecimal digests (40, 40 and 64 characters). It verifies the commit/tree and
workflow source bytes at that commit, reads every job page for that attempt and
every artifact page for the run, then rechecks current run identity. A changed
attempt, missing page, inconsistent total, duplicate identity or exhausted
bound refuses the receipt. Bounds are 1,600 records per inventory, 40 GET
requests, 120 seconds and 2 MiB per API reply.

`node scripts/release-run-evidence.mts REQUEST.json ARTIFACT_ID RETAINED_FILE`
also compares an already retained opaque file with that artifact's current
provider digest and exact byte count. Missing, expired or undigested artifacts
refuse before file I/O. One regular-file handle streams at most 512 MiB using a
64 KiB buffer plus a one-byte growth probe, checks mutation and SHA-256, then
refreshes the complete API evidence and refuses changed run/artifact identity.
Both collections and file comparison share a 40-request cap and cooperative
120-second receipt/refusal deadline. An in-flight bounded `gh` call may finish
after the deadline; filesystem I/O has no hard cancellation. This is not a
process-termination guarantee. The receipt includes both complete API receipts
and their digests so its byte/metadata binding remains reviewable; it does not download, parse, extract
or execute them. Provider upload size and digest describe the uploaded object
in [GitHub's artifact uploader](https://github.com/actions/toolkit/blob/main/packages/artifact/src/internal/upload/upload-artifact.ts),
not an extracted-package acceptance. Producing job/attempt and execution lineage
remain unknown; a successful byte comparison grants no release authority.

The content-digested receipt records source workflow bytes, not authenticated
execution lineage. Artifact scope covers all attempts of the run; GitHub's
[artifact API](https://docs.github.com/en/rest/actions/artifacts) reports no
producing job or attempt, so those bindings remain explicitly unknown. Missing
archive digests and expired artifacts remain visible. An archive digest does not
qualify its package contents. This collector downloads and executes no candidate
bytes and establishes no runner/cache isolation, custody, signing, eligibility
or publication authority. A protected controller must separately prove those
bindings and refresh current state at the action boundary.

## Standalone CLI integration artifact

Every released external-client claim points to an exact standalone CLI archive,
the aggregate SHA-256 manifest, declared host prerequisites, and the applicable
CLI/schema compatibility documentation. The release matrix already produces
separate Windows, Linux, Intel macOS, and Apple-silicon macOS CLI archives; an
integrator need not compile Portcove or install/run the desktop application.
Artifact presence is not platform or frontend qualification, and the current
alpha signing and hands-on limits still apply.

[#46](https://github.com/boburning/portcove/issues/46) remains the package,
checksum, signing, and exact-artifact qualification owner. #30 owns the public
machine contract and compatibility policy, while #243 owns the independent
consumer exercise. A development exercise may use one exactly identified
packaged candidate to avoid a release dependency cycle, but final author
guidance must point to an available public release and may not describe the
candidate as released.

Beginning with the first release after Alpha 2, CLI archives use explicit,
versioned names derived from the same metadata checked against the release tag:

```text
portcove-cli-<version>-windows-x86_64.zip
portcove-cli-<version>-linux-x86_64.tar.gz
portcove-cli-<version>-macos-aarch64.tar.gz
portcove-cli-<version>-macos-x86_64.tar.gz
```

The executable inside remains `portcove.exe` on Windows and `portcove` on
Linux/macOS. Alpha 1 and Alpha 2's unversioned archive names and platform
manifests remain historical assets; do not rename, duplicate, or replace them. First-party future
release tooling accepts only the versioned names.

## Declared package policy

`release/package-policy.json` is the single required-output definition. It
declares interface, operating system, processor, format, native filename rule,
display label, and experimental presentation independently of whatever a build
happens to emit. The current exact matrix is:

| Platform       | Desktop                           | Standalone CLI |
| -------------- | --------------------------------- | -------------- |
| Windows x86_64 | NSIS setup installer              | ZIP            |
| Linux x86_64   | AppImage, DEB, RPM (experimental) | TAR.GZ         |
| macOS aarch64  | DMG (experimental)                | TAR.GZ         |
| macOS x86_64   | DMG (experimental)                | TAR.GZ         |

Release jobs pass `--bundles nsis`, `--bundles appimage,deb,rpm`, or
`--bundles dmg` to the installed Tauri 2 CLI as appropriate; they do not assume
that every operating system accepts one common target list. The policy neither
adds MSI, portable desktop ZIPs, new architectures, Flatpak, nor updater
artifacts. Changing a required output is a protected release-policy change, not
a way to make a failed build disappear.

The builders derive the version from checked Cargo/Desktop/Tauri metadata,
package the CLI, extract that final archive, verify the executable name and
native architecture, run `--version`, and exercise a machine command against an
isolated temporary library. `write-release-checksums.mts` then accepts exactly
the policy's platform outputs and creates an internal platform manifest. The
cross-platform reconciler independently requires the complete policy matrix,
recomputes every hash, rejects unsafe paths, missing/unexpected/case-colliding
names and version/format mismatches, and produces the final inventory plus one
public `SHA256SUMS.txt`. Filename checks identify the expected package; the
extracted executable inspection is the practical architecture evidence for the
CLI. Desktop runtime and installed-package qualification remain separate.

## Windows preflight

From the repository root, run the complete local gate before creating a tag:

```powershell
.\scripts\release-preflight.ps1 -Tag v0.1.0
```

The gate verifies release metadata, a no-reuse `just audit --fresh`, the frontend production dependency audit, active catalog repositories, direct PS1 upstream ownership, the native Tauri bundle, and an isolated silent install/respond/uninstall lifecycle. Install the pinned audit tools with `scripts/bootstrap-quality-tools.ps1` before running it locally. It never uses or modifies the normal Portcove library. Network-backed catalog and dependency checks use the configured credentials or normal anonymous public access.

`release-preflight.ps1`, `package-local.ps1`, and `test-windows-installer.ps1`
accept `-Help` or `--help` before any storage, build, Registry, or installer work.
`check-release-metadata.mts` and `check-retcomm-upstreams.mts` accept `--help`
without reading release/catalog inputs or contacting upstreams. A failed preflight
names the failing command and child exit code; retain its output and any reported
log or evidence paths before retrying. Offline upstream checks only validate local
mappings, and a scoped live check leaves unselected upstreams unassessed.

After it passes, refresh the shareable local artifacts and checksum manifest:

```powershell
.\scripts\package-local.ps1
```

An explicit `-Version` is accepted only when it matches the central release metadata.

To qualify replacement of an earlier local build, retain its installer before rebuilding and run:

```powershell
.\scripts\test-windows-installer.ps1 -InstallerPath <new-setup.exe> -UpgradeFromInstallerPath <earlier-setup.exe> -ExpectedExecutablePath <new-portcove-desktop.exe>
```

### Isolated Windows installer checks

The test refuses to replace an existing registered Portcove installation. Its
ordinary silent-install route performs these checks in a new isolated directory:

1. **Establish the isolated inputs.** Bind the candidate installer and expected
   executable identities to the run. When an earlier installer is supplied,
   install and cleanly close that predecessor before replacing it. Retain the
   predecessor identity and upgrade result separately from a fresh installation.
2. **Install silently.** Require the installer to succeed and the isolated
   installation to have exactly one matching registration. Retain the installer
   digest, signature observation, install mode, observed exit code and registered
   version. An observed unsigned artifact remains unsigned.
3. **Launch and check responsiveness.** Compare the installed executable with
   the expected bytes and wait for a responsive application window. Retain the
   installed hash, window title and responsiveness result. A process start alone
   does not complete this check.
4. **Close normally.** Request closure through the application window and retain
   the observed application exit code. Forced termination is a failed smoke
   result; an unobserved exit code cannot establish a clean exit.
5. **Uninstall and compare preserved data.** Require managed installation files
   and registration to be removed. Compare the before/after preservation
   manifests: the library database and clearly labeled test data marker must
   survive replacement and uninstall. Retain cleanup and process observations,
   including any unavailable uninstaller-child exit code described below.

Expected executable hashing reproduces Tauri's single fixed bundle-type marker
substitution from `UNK` to `NSS` in memory; it compares the entire resulting file,
and reports both raw and bundled hashes. Same-version build replacement is
recorded separately from a future version-number upgrade, signed production
validation, and interactive shell observations. The harness emits its structured
result and can retain a phase journal at the explicit `-EvidencePath`; failed
runs preserve their owned run directory. The packaged session below adds its
build record, verified tool copies and retained receipt.

The [NSIS uninstaller launcher returns before its temporary self-copy finishes](https://nsis.sourceforge.io/When_I_use_ExecWait_uninstaller.exe_it_doesn%27t_wait_for_the_uninstaller).
The harness retains the launcher handle and observes any live direct child using
its parent PID, start time, exact executable hash and owned temporary path. It
retains the verified child handle and waits within the original operation
deadline before checking managed-file and registration removal. An unverified
child is never terminated by this path; a timed-out verified child is a failed
run. A child that already exited is not assigned an invented exit code, and
absence of a live child never replaces the final cleanup and preservation checks.

Prepare a reproducible hands-on session for an existing qualification library with:

```text
node scripts/qualification-report.mts --cli <portcove.exe> --library <qualification-library> --output <new-report-directory>
```

The report captures versioned core diagnostics, catalog, sources, status, activity, capacity, and backup listings, plus the exact CLI hash. Its checklist leaves gameplay, audio, controller, and save/load observations unassessed. Keep these local reports private because source references contain local paths; they never contain source file contents or account credentials. The tool does not edit catalog qualification flags.

Use an existing CLI executable verified for the session and an initialized test
library containing `portcove.sqlite3`; the output directory must be new. Run
`node scripts/qualification-report.mts --help` for the complete input contract
without executing the CLI or writing evidence. Unsupported JSON/report shapes
remain failures and identify the format mismatch; use the CLI and report tool
from the same reviewed source instead of treating missing evidence as a pass.

For a packaged Windows qualification session, first create an immutable build
record from the exact clean candidate checkout. Put all package inputs below
that checkout; ignored `target`, `work`, or `outputs` directories are suitable.
The predecessor version and installer digest are mandatory:

```powershell
node scripts/write-windows-qualification-build.mts `
  --repository <absolute-clean-candidate-checkout> `
  --installer <candidate-setup.exe> --cli <candidate-portcove.exe> `
  --desktop <raw-candidate-portcove-desktop.exe> `
  --predecessor <published-predecessor-setup.exe> `
  --predecessor-version <published-version> --output <new-build-record.json>
```

Record the printed build-record SHA-256 outside the candidate checkout. Prepare
then rechecks that hash, candidate commit and tree, tracked cleanliness, every
package, and every qualification tool even with `-ValidateOnly`:

```powershell
.\scripts\windows-qualification-session.ps1 -Action prepare `
  -SessionRoot <new-absolute-disposable-directory> `
  -CandidateCheckout <absolute-clean-candidate-checkout> `
  -BuildRecordPath <build-record.json> `
  -ExpectedBuildRecordSha256 <sha256>
```

The command refuses any existing Portcove installer registration and any
existing, relative, volume-root, or reparse-backed session directory. It copies
and verifies all executable inputs and tools below the session root. The normal
installer probe performs the predecessor upgrade, responsive-window smoke,
complete recursive preservation comparison, and uninstall. Before uninstall it
copies the verified packaged desktop into the session. The later functional
session therefore leaves no installer registration while it runs. Both
`PORTCOVE_LIBRARY` and `PORTCOVE_PREFERENCES` remain below the session root.

Run later actions with the verified copy at
`<session>\tools\windows-qualification-session.ps1`. Checkpoint asks the
journaled desktop process to close, captures a new report
with the verified packaged CLI, and never overwrites an earlier or interrupted
sequence. Every relaunch appends a process-run record, and each checkpoint links
to the run it closed. Recovery accepts a pending launch only when one process
matches the exact executable path and hash and began no earlier than five
seconds before the recorded request. Use `-Relaunch` when the next scenario
needs restart persistence:

```powershell
& <session>\tools\windows-qualification-session.ps1 -Action checkpoint `
  -SessionRoot <same-disposable-directory> -Label after-storage -Relaunch
```

Finish closes a running session through its main window, captures one final
report, preserves the exact pre-finish session metadata, and writes a hashed
receipt covering the recursive retained evidence. A later invocation
cannot recover the original Windows process handle, so a close followed by
process disappearance is recorded as an unobserved exit code rather than a
clean-exit claim. An interrupted finish resumes its recorded attempt and reuses
the exact snapshot or receipt instead of repeating the final checkpoint:

```powershell
& <session>\tools\windows-qualification-session.ps1 -Action finish `
  -SessionRoot <same-disposable-directory>
```

If prepare fails after an installer starts, keep the session root and run
`-Action abort`. Abort requires the phase journal hash to have been bound into
`session.json`, then verifies its owned paths and recorded uninstaller hash. It
acts only inside the validated session root. If it cannot
prove that identity, it leaves the partial evidence and installation untouched
for explicit recovery. It records an abort only after proving that no owned
process, managed install file, or Portcove registration remains.

The session record is automated package and application-state evidence only.
Synthetic fixtures may prove orchestration, refusal, and recovery behavior, but
they do not establish source admission, game installation, gameplay, audio,
controller behavior, save compatibility, comprehension, publisher prompts, or
physical-platform behavior. Leave every unobserved row unassessed. If candidate
source or package bytes change, create a new build record and session root.

## Roadmap readiness snapshot

Before publishing a tagged release, review the live Portcove Roadmap view for
the target stage, its open blockers and deferred items, and the catalog's actual
qualification state. Then generate a new immutable snapshot under
`docs/releases/`:

```powershell
node scripts/roadmap.mts snapshot --release "Alpha 1" --output docs/releases/0.1.0-alpha.1-readiness.md
```

Legacy snapshots retain historical cumulative stages. New Public beta snapshots
include completed Alpha 1/2 history and Public beta; 1.0 includes all historical
stages and both current milestones. Active legacy targets are migration conflicts.
These cumulative declarations are separate from routine candidate safety checks. `Target release`
is a forecast; `Release commitment` controls the gate. The generator follows
genuine transitive blocking relationships and reports later, Planned,
unclassified, or Project-missing dependencies as conflicts. Parentage and
related-work links do not block a release. Relevant unclassified work and known
shipped-scope safety conflicts prevent a falsely green result, while unrelated
unscheduled intake does not. Only Project `Status = Done` counts as complete.
Use `roadmap.mts readiness --release <stage>` for a live derived preview. The
generator reports closed/not-planned issues whose Project status disagrees and
accepts evidence links only from the explicit Completion evidence section,
implementation pull requests/checks, or qualification and rehearsal records.

Codex and deterministic automation execute feasible validation, investigate
failures, repair within scope, perform a separate review pass, and record exact
evidence; the owner does not repeat adequate automated checks. Human participation
is required only when intrinsic to the claim, such as novice comprehension or
actual gameplay observation. A packaged process start, synthetic fixture, VM,
or physical-device script proves only what it directly observed.

Review and complete the snapshot's test, CI, rehearsal, signing, intrinsically
human-validation, and explicit-limitation sections before committing it. The file records generation
time, commit, Project URL, completed and unfinished required items, blockers,
conscious deferrals, evidence links, and a qualification summary derived from
`catalog.json`. Never edit an older snapshot to reflect a priority change;
generate a new dated/versioned snapshot. The live Project remains authoritative.

Use two linked records to keep the release commit fixed. The committed
pre-publication snapshot identifies its observation/base SHA and the remaining
gates. After the finalization PR is reviewed and merged, freeze the full merge
SHA as `C` and post an execution record on the release issue or PR, keyed by
version and `C`. That record binds the snapshot path/blob/SHA-256, release-note
digest, required CI and its tested tree, Windows preflight/installer evidence,
exact manual rehearsal run/attempt, protection settings, and limitations.
Do not commit the future rehearsal result back into the snapshot: that would
change `C`. Any committed change after rehearsal requires a newly established
candidate and repeated final checks. Historical snapshots retain their original
SHA and never certify a newer commit. Project fields remain the live authority.

Normal merge authority, authorization to create the exact tag at `C`, and
authorization to publish the verified tag-generated draft are separate
boundaries. Routine merges use mandatory CI, an explicit separate review result,
resolved threads, current revision/authority confirmation, and no administrator
bypass. Tagging and publication remain explicit protected boundaries. Before tagging,
re-read release immutability and effective tag protections described in
[REPOSITORY-SETTINGS.md](REPOSITORY-SETTINGS.md). After tagging is authorized,
inspect the tag build's own packages and checksums; rehearsal bytes do not
certify a later build. Keep the draft unpublished until its asset identities,
notes, prerelease flag, and required package tests are verified and publication
is explicitly approved. Verify release immutability and public asset integrity
after publication; the repository setting alone is not that evidence.

## Tagged build

Pushing `v*` starts `.github/workflows/release.yml`. A cheap identity job first
checks version, tag, package policy, and workflow contracts. It then unlocks the
secret-free reusable qualification and a three-platform build matrix plus the
dedicated Intel producer in parallel. Release validation consumes and verifies
the qualification plan digest and exact checkout before running the release
audit profile, dependency audit, and live upstream checks. The reduced release
audit profile retains dependency policy, rscheck, and release-unit coverage;
qualification owns the remaining complete cross-platform inventory. The native Intel verifier starts as soon as
that producer is complete, without waiting for unrelated platform builds. A
fail-closed result gate requires qualification, release validation, every producer, and native Intel verification before
assembly. Build jobs have read-only
repository permission and stage only the versioned CLI archive, explicitly
selected native distributable packages, one internal platform SHA-256 manifest,
and a producer record bound to the exact run, attempt, revision, platform, and
version.

The Intel CLI and DMG are cross-compiled on the Apple-silicon `macos-15` runner
with the repository-pinned Rust toolchain and explicit
`x86_64-apple-darwin` target. A separate `macos-15-intel` job downloads those
exact staged bytes, executes the CLI archive, verifies the DMG's bundle identity,
Mach-O architecture, deployment metadata, and dylib references, then performs a
native launch and clean close. This preserves Intel execution evidence while
moving compilation off the scarcer Intel runner. Revert the Intel matrix entry
to `macos-15-intel` and remove its explicit target if hosted cross-compilation or
native verification becomes unreliable; do not waive the Intel job.
Each platform label has an independent Rust cache series, so the two
Apple-silicon-hosted target graphs cannot race to populate one immutable key.

After validation, every builder, and Intel verification succeed, the read-only
`assemble` job independently
validates the exact matrix, recomputes every package checksum, generates an SPDX
2.3 JSON SBOM with the commit-pinned Syft action, and finalizes one immutable
payload. `SHA256SUMS.txt` covers every public package and
`Portcove-SBOM.spdx.json`; the SBOM inventory records each package's checksum and
size. The four platform manifests and build-time inventory remain internal
validation inputs rather than redundant release assets.

Reruns replace same-named transient artifacts, but assembly accepts producer
records only from the current workflow run and revision and never from an attempt
newer than its own. This permits safe whole-workflow or failed-job retries without
silently combining stale platform outputs. If lineage reconciliation fails,
rerun the failed producer or the complete workflow; never copy an artifact from
another run into the matrix.

On a tag run, only the isolated `attest` job receives `id-token: write`,
`attestations: write`, and `artifact-metadata: write`. It checks out no candidate
code and runs no repository script. One commit-pinned `actions/attest` step
creates build provenance for every final payload file, including the checksum
manifest and SBOM. A second binds the SPDX SBOM only to the package digests in a
deterministic internal checksum list derived from the exact release inventory;
the SBOM is deliberately not a subject of its own SBOM attestation. That list is
a transient workflow artifact, never a release asset. The `publish` job cannot
begin until those attestations succeed. It receives only `contents: write`,
downloads the already assembled payload and precomputed metadata, and creates or
reconciles one draft release.

The publisher refuses to change a published release. The first run supplies the
precomputed download section while GitHub appends its categorized release notes
during draft creation, and `gh release create --verify-tag` refuses a missing
remote tag. A rerun verifies an existing draft body byte for byte and fails
closed instead of editing it. The publisher rechecks draft
state before every asset deletion or upload; repository-level immutable releases
provide the server-side boundary if publication happens between that check and
the mutation. The release-workflow fixture executes this exact inline publisher
against a controlled fake GitHub boundary. It proves that an identical retry
reuses one draft, an interrupted upload leaves a recoverable partial draft, the
next retry restores the complete exact asset set, and a published release is
refused without mutation. The fixture has no network, tag, release, credential,
or publication authority.

Rehearsal, draft publication and failed runs retain immutable attempt artifacts
under the seven-day policy above. There is no automatic early-deletion job or
additional cleanup credential. Earlier deletion requires independently verified
successor custody and exact IDs; expiry proves neither custody nor headroom.
Tags containing a SemVer prerelease suffix are marked as prereleases automatically.
The signed application-updater path remains subject to #534's separately approved
initial configuration and applicable native/public acceptance.

The verified inventory adds or replaces one marked desktop-first download
section in the draft body while preserving reviewed prose and GitHub's
categorized changes. Repeated generation cannot duplicate the section. Links
are bound to the exact tag, and preview notes do not use GitHub's stable-only
latest-release endpoint.

Release matrix, aggregate, inventory, checksum, and staging paths must be
owned child paths of the checkout. Existing linked or reparse-point components
are refused before release tooling reads, replaces, creates, or copies those
outputs.

## Release rehearsal

The **Release** workflow also offers a separate manual packaging rehearsal. A manual run executes the same cheap identity gate, reusable exhaustive qualification, bound release validation, selected package profile, read-only assembly, SBOM generation, payload finalization, public checksum verification, and internal SBOM-subject checksum verification, but tag-only attestation and publication remain disabled. Successful and failed rehearsals retain attempt artifacts under the seven-day policy. A rehearsal never creates an attestation, tag, draft release, or published release. This diagnostic entry point is separate from #534's automatic fixed-controller path and is not a recurring owner step for that path.

From an authenticated GitHub CLI, start and follow the rehearsal with:

```powershell
gh workflow run release.yml --ref main
gh run list --workflow release.yml --event workflow_dispatch --branch main --limit 10
```

Identify the specific dispatch by workflow, event, branch, dispatch time, actor,
and `head_sha = C`; never select an unrelated latest run. Require successful
identity, qualification, bound validation, every expected builder, Intel native verification, the
result gate, and reconciliation, with publication skipped.
Record the run ID, attempt, timestamps, SHA, job outcomes, reconciliation result,
and cleanup state in the external execution record. If main moves during the
freeze or dispatch resolves another SHA, stop readiness until the candidate is
explicitly re-established. Do not silently retarget it.

The rehearsal proves that the current commit can produce packages on hosted builders. It does not replace signing, installation, gameplay, controller, or other hands-on validation tracked in the live Portcove Roadmap.

Before publishing the draft:

1. confirm the aggregate `SHA256SUMS.txt` covers every public CLI archive, desktop bundle, and `Portcove-SBOM.spdx.json`, and that the logs show all four internal manifests were accepted;
2. verify the committed observation snapshot and external execution record both refer to the intended frozen candidate;
3. compare release notes with live Blocked & Deferred items so manual or signing work is not overstated;
4. keep unsigned artifacts clearly identified until the signing issue has matching completion evidence;
5. perform the target-shell and hands-on checks appropriate to the release; and
6. publish only after the draft contents, version, channel, snapshot, and Project readiness are correct.

The generated draft begins with these sections before categorized changes:

1. **Download the desktop app** — operating-system and processor choices, with
   experimental status retained;
2. **Command-line tools** — clearly separate standalone CLI archives;
3. **Verify your download** — the one aggregate manifest and commands that check
   a selected package without downloading the rest, plus `gh attestation verify`
   for GitHub-hosted provenance;
4. **Software bill of materials** — the checksummed SPDX 2.3 JSON inventory and
   its scope; and
5. reviewed release changes, known limitations, upgrade guidance, and
   troubleshooting.

It states that Desktop needs no separate CLI, a CLI archive is not a graphical
app, an AppImage is not universal Linux or Steam Deck evidence, and GitHub source
archives require a development build. Checksums establish agreement with the
published bytes, not independent publisher identity, malware freedom,
operating-system signing, updater authorization, or gameplay/platform evidence.

Creating a tag does not authorize weakening catalog integrity, embedding game data, or marking deferred gameplay and operating-system observations as complete.

## Post-publication verification and release channels

Only after separately authorized publication can public reachability and
integrity be checked. Download `SHA256SUMS.txt` and one selected package, require
exactly one matching manifest line, and use `Get-FileHash`, `sha256sum --check
--strict`, or `shasum -a 256 --check` as shown in the generated release body.
Then use `gh release verify-asset <tag> <asset>` and `gh attestation verify
<asset> --repo boburning/portcove` for each public asset and record the immutable
release/tag, exact commit/run, API size/digest, attestation result, and HTTP result.
Historical manifests stay untouched.

`scripts/select-release-channel.mts --channel preview|stable --input releases.json`
selects the highest eligible SemVer from a complete published release inventory.
It excludes drafts, keeps public 0.x in Preview, and requires separate production
eligibility for Stable. Preview also includes eligible final releases. Optional
`--eligibility evidence.json`, `--current-version VERSION` and `--target TARGET`
apply explicit eligibility, increasing-version and target constraints. The caller
must authenticate eligibility evidence; a local JSON file is not a trust root.
Publication dates and GitHub latest never rank versions. Generated download links do not need discovery:
they always name their exact tag. Do not use `/releases/latest` or
`releases/latest/download` as a preview resolver.

Routine release preparation is designed to require no owner reconciliation of
filenames, tables, or checksums. Current governance still separates ordinary
merge authority, tag creation, and publication of the verified draft. Removing
those per-release approvals requires a separately reviewed protected controller,
bounded credentials, negative/recovery tests, and explicit authority; this
packaging change does not grant it or introduce another manual gate.

## Upgrade acceptance and technical previews

The first Windows public beta requires the complete applicable Windows/shared
verified updater under [#52](https://github.com/boburning/portcove/issues/52):
Windows x86-64 current-user NSIS, the existing WebView2 baseline, actual installed
upgrade/recovery, signatures, provenance, production feed continuity and safe
preservation. Linux application/package/native acceptance is planned for a
subsequent beta under existing #45/#46 and component owners, consuming completed
#225 at its actual scope. It is not a prerequisite for this Windows launch.
Shared mechanisms and shared or Windows-affecting defects remain required
regardless of test execution OS.

Installed macOS Intel/Apple Silicon bundle qualification (#45/#226) and Deck
qualification (#51/#213–#217/#535) retain their existing later-beta and
Required-before-1.0 commitments. Later Linux and other platform claims require
their own exact native/package/updater evidence; no date or pass is supplied by
this timing change. #46 retains final production package requalification for
1.0; #52's independently finishable Windows/shared first-beta minimum does not
wait for that later closure. Until the actual Deck matrix passes, an available
Linux build is not official Deck/Gaming Mode support or Valve Verified evidence.
RC stabilizes one exact candidate, not all development.

The [delivery contract](DELIVERY.md) separates application/catalog/game updates,
Stable/Preview eligibility, updater authenticity, SHA-256 reconciliation, OS
publisher identity and OS enforcement. Automatic mode uses one-time consent,
busy-state exclusion and safe-time application without recurring release-note
approval. Pre-1.0 public releases remain Preview-only; Stable becomes the default
after production approval. Paid publisher signing is optional. These are planned
contracts, not evidence that updater behavior, custody or unattended publication
has already been implemented or activated.

Early technical previews may use a documented, verified manual upgrade path.
Use a small explicitly qualified scope after applicable trust gates permit;
label limitations and publisher prompts clearly and require disposable or fully
backed-up libraries. Record package hashes and the unassisted first-play/recovery
scenario outside the development checkout. A preview is not evidence of universal
catalog or platform qualification, and its plan does not authorize publication.

Missing required Windows/shared evidence keeps the first Windows Public beta
open; missing Linux-only application evidence keeps its subsequent Linux
acceptance open. Neither stops unrelated implementation or an otherwise
eligible incremental preview. A
successful manual reinstall cannot complete the baseline updater. DEB/RPM remain
package-manager-mediated; standalone CLI self-updating and optional extra formats
remain outside the baseline. Record exact unsupported paths and recovery limits.

## Optional signed catalog publication

`scripts/sign-catalog.mts` signs an explicit catalog file using an existing Ed25519 PKCS#8 private key file and writes a new envelope without overwriting an existing output. This is offline publisher tooling, not a production key generator or hosted release workflow. The consumer trusts no publisher by default. Configure custody, recovery, rotation, a strictly increasing catalog sequence, and an independently verifiable public-key distribution channel before publishing a production feed. A catalog signature is neither an application code signature nor desktop updater authorization. Exact invocation and verification steps are in [SIGNED-CATALOG.md](SIGNED-CATALOG.md).

## GLib development policy and Linux release authorization

Development security-policy success does not authorize a Linux artifact. Before
an affected Linux release, run `just audit --fresh --profile release`; final
asset assembly and read-only pre-upload authorization independently enforce the
same #706 decision. The publisher retains no source execution authority and
checks decision freshness/expiry before each mutation. The first publication tag
must be bound through the existing reviewed approval record. A changed native
production/build graph requires focused source review; there is no routine Rust
source fingerprint to maintain. See the [current procedure and dated approval](releases/2026-10-14-linux-beta-risk-706.md).
Ordinary Windows preflight remains independent of Linux authorization. No
publication, approval renewal, advisory dismissal or remediation is implied.

## Metadata-only renewal in the existing coordinator journal

A schema2 coordinator may retain `published_metadata` and `metadata_renewal`
with capacity sub-schema2. The former binds the application public component,
root/offline targets, six exact decimal-string version floors and expirations,
unchanged record digest, actual publication receipt and whole-site
`publication.site_generation_sha256`. The whole-site marker includes the catalog;
it is distinct from the application-only public component digest. Missing state
holds renewal. Initial seeding is a separately authorized import: its fixed caller
must actually verify the independently ratified root, safe-expiry Tough feed and
independent public readback. Hash parsing and Git persistence do not authenticate
those observations or grant initial setup authority.

`runBoundedMetadataRenewalOperation` freezes the verified renewal descriptor,
uses its own observation time, and commits its exact pending effect through the
existing remote checkpoint adapter before the supplied effect. It never allocates
a candidate, invents a source/version/review, changes the active reservation or
rewrites earlier release observations. Two transient and three substantive
recovery increments apply across the same prior published generation; changing
the descriptor does not reset them. Stable logical destinations identify purposes,
such as a role artifact or Pages deployment, rather than changing run/artifact IDs.
Remote completion remains pending until exact provider readback is durably
recorded. Publication advancement needs a resolved operation with the matching
receipt and all five advancing online floors. Offline anchors remain unchanged.

Compact prior-effect groups remain inside the same checkpoint. They retain the
logical subject/destination, completion and retry floors, plus the original raw
operation checkpoint, ID and full-operation digest. The original immutable Git
history retains provider receipts. `readRetainedCapacityOperation` resolves that
bounded original checkpoint without traversing history; a sparse restored caller
must obtain the explicitly named checkpoint objects before requesting its raw
receipt. Current candidate effects and current published-generation effects
cannot be dropped or rewritten. Old metadata groups become collectible only after
a bound published successor readback; active-candidate groups survive renewal.
A 96-purpose lifecycle cap and six proof attempts per purpose remain fail closed.
The focused workload covers 63 candidate purposes, seven metadata purposes and
all five recovery increments within the existing64KiB checkpoint bound. The
operation also reserves its declared bounded receipt budget before any effect.

An operation may bind an original fixed executor identity and a separately
recorded recovery executor identity. These are association fields, never caller
authentication. The admitted wrapper must freshly verify the actual job identity,
remote ownership and original-job termination before another executor resolves
its result. A nonce, local checkpoint, imported report or JSON receipt provides no
credential, lease, protected execution or publication authority. Legacy schema1
replay bytes remain unchanged; routine metadata admission uses the new explicit
schema and authenticated published-state prerequisite.

`prepareAuthenticatedMetadataRenewal` is the maintained fixed-tool adapter. The
admitted caller supplies independently ratified executable/root hashes and the
independently observed complete application component digest. It snapshots the
bounded public inputs, invokes the actual copied `prepare-tuf-renewal` executable
with a credential-free environment, then binds its verified descriptor, context
and complete output inventory to an in-process session. Imported JSON cannot
replace that session. `inspectPreparedMetadataRenewal` rechecks retained output
and tool identities before role-job or journal use. Failures retain private work;
the adapter neither discovers keys nor grants provisioning or execution.

The automatic coordinator retains its actual renewal session, controller-tool
receipt, full public-site custody and current maintenance-reader controls in a
same-process continuation. `requireActualCoordinatorMetadataPreparation` checks
those original receipts, the unchanged published seed and descriptor, exact
local/remote checkpoint, public generation marker and fresh controls before a
fixed context producer may consume them. Its mode is explicitly `renewal`; an
initial empty feed requires the separate bootstrap route. The original 170-second
role deadline continues through this handoff. Serialized CLI output cannot
recreate the private session or reset that budget.

On a later renewal wake, the context continuation first reconciles the existing
settled context upload. Its exact original numeric coordinator job and complete
artifact inventory must be terminal and unchanged across the read. A surviving
context is reused only after the existing pinned attestation verifier, original
receipt/predicate association and exact current Tough input inventory agree;
its original checkpoint remains historical lineage. A missing or expired handoff,
or a failed original producing job, may consume the existing bounded transient
recovery counter before a new upload. Incomplete inventories, active producers,
unavailable reads and failed context verification refuse rather than authorize
another effect. Reuse emits an explicit `attestation_required: false` locator;
fresh uploads retain the separate required attestation. Neither result is signing
or publication authority, and neither resets the original coordinator deadline.

`acquireActualCandidateBuildingEligibility` collects genuine compiler, SPDX,
whole-opportunity control and pre-sign native evidence while the exact candidate
is still qualifying. Its private same-process proof is exclusively for the
separate qualifying-to-building journal CAS; it creates no aggregate, payload or
publication admission. Ordinary acquisition still requires building/publishing,
and caller flags or imported successful reports cannot select the earlier gate.
`advanceActualCandidateToBuilding` consumes that same-process proof, rechecks the
actual retained native/SPDX/public inputs and fresh controls, then advances the
exact qualifying reservation through the existing local/remote checkpoint CAS.
It uses the dedicated journal credential only after protected admission. An
ambiguous remote handoff retains its local checkpoint and requires recovery;
the helper never retries a mutation. Aggregation and payload admission still
perform their own checks after the durable building checkpoint.
The publishing writer separately requires the genuine post-sign
`release-publication` context and its native journey/SPDX/public-input custody.
`requireActualCandidatePhaseAdvance` rechecks the original private context,
controls and exact local/remote checkpoint before exposing a same-process
handoff. A prepared publication may bind that exact original context to the
returned phase checkpoint; an imported receipt or caller-updated hash cannot
rebind it. This handoff does not establish a published Release, a public TUF
generation or candidate completion.
The promoting writer separately consumes the actual owned immutable-Release
completion receipt, retains the exact settled publish operation and Release
identity in its projection, and rechecks post-sign custody and current controls
before the same journal CAS. Public Release presence or an imported completion
object cannot select this route. The active reservation remains intact for the
later independently authenticated TUF/site publication and completion proof.

Optional candidate `stage_evidence` retains at most three phase histories with
six attempts each, matching the initial attempt plus two transient retries and
three substantive repairs. Each attempt binds the preceding checkpoint, exact
release run and consumed recovery counters to a public projection of immutable
Check/artifact/operation locators and hashes. Prior entries cannot be changed,
removed or backfilled; only the corresponding forward phase transition may
append one entry. The existing 64KiB whole-checkpoint bound applies before any
ref mutation. These projections support recollection after a crash; stored
hashes or locators never authenticate a later action. Missing or expired actual
proof remains held. Legacy candidates without this optional field retain their
historical encoding and behavior.
The complete workflow's existing `independent_admission` job requires the signed
`production-release-admission` environment identity before that phase writer may
release its journal credential. Consolidated setup must restrict this environment
to the exact protected controller tag, disable administrator bypass and require
no recurring human reviewers. This is preparation, with no environment settings
or credentials activated. Schema-1 admission-only remains a separate read-only
tag-bound identity and cannot mint this proof.

`prepareReleaseSigningContext` connects the actual same-process pre-sign native,
SPDX, payload signature and public build-input receipts to a Tough-authenticated
prior repository. It reconstructs the selected Windows/Linux Preview records
with the existing record factory, preserves every historical target byte, and
refuses changed immutable paths, Root/key mismatches or a different verifier.
The private getter rechecks the complete retained tree and original receipts;
its full record digest and candidate/aggregate/signature binding are expected
inputs for the later role and publication joins. Versions retain exact numeric
`u64` JSON tokens. Initial empty-feed bootstrap, cross-job attestation, five-role
execution and post-sign qualification remain separate requirements. This
preparation neither publishes nor turns pre-sign qualification into publication
admission, and it cannot accept imported context or qualification JSON.

The prepared `signed-package-compatibility-v1` temporal profile requires global
authority configuration schema 2, explicitly ratified under its existing source,
configuration and grant digests. Native report schema 1 keeps its original
interpretation. Report schema 2 binds the exact signed context, signatures and a
distinct predecessor to install-over-prior, candidate-launch, retained-state and
package-rollback observations. A report cannot select the profile for its reader.
The configured native reader must independently expect the same profile and pair.

Only an independently established initial empty feed can use the distinct report-2
`initial-empty-feed` journey: it binds the metadata-bootstrap descriptor, setup,
initial site preimage and empty logical-record digest, with fresh-install,
candidate-launch, retained-state and signature-cryptography observations. The
fixed caller must derive that expectation from the actual bootstrap journal,
authenticated Tough empty prior and current published seed. Parsing its public
digest fields cannot establish absence. It cannot assert rollback or supply an
invented predecessor; a noninitial release retains the distinct predecessor rule.

Both report-2 branches retain the three explicit obligations for ordinary public
discovery/download, updater journal/recovery and the public manifest journey.
Package compatibility is a prepublication predicate; actual public V0-to-V1 proof
remains necessary for #534 acceptance after publication. These contracts prepare
the consolidated conditional setup selection. They grant no signing, host,
credential, publication or native acceptance authority and do not clear current
holds without genuine fixed producer and consumer evidence.

The shared installed-updater UI driver additionally reads the shipping sanitized
`get_application_update_status` command before any UI mutation and after staging.
Unconfigured/package-managed installations, earlier staged/apply state and pending
recovery refuse. A restart control alone cannot qualify a candidate: staged
version, Preview channel, positive byte count and install eligibility must match.
All maintained NSIS/AppImage/macOS adapters retain both status observations in
their existing report. The macOS adapter remains outside the initial-beta gate.
The shipping status query requires no qualification feature, IPC hook or loopback
feed. It performs the product's normal staging reconciliation; retain raw fault
preimages before application startup or querying status. The shared driver also
exercises one explicitly selected existing schedule, staging or apply recovery
button, then checks that its hold cleared while unrelated holds and unrelated
staged/apply state remain. It performs no implicit recovery or generic IPC
mutation. Controlled driver tests establish harness behavior only; actual public
origins, payload hashes, restart/process ownership, retained user state, signature
refusal, withdrawal/forward repair and recovery remain independently observed
obligations. Existing qualification-marker restart harnesses retain their scope.

The fixed `prepareControllerReleaseSigningContext` caller additionally recovers
the current journal at the settled payload checkpoint and derives the complete
public-site pins from its published seed. It acquires the whole site, invokes
the authenticated Rust Tough verifier, checks the exact prior publication and
ratified public Root/offline Targets/payload-registry bytes, then prepares new
records and brackets the journal again. It shares the payload role's remaining
deadline through provider, site and verifier reads. Missing prior publication
refuses; it cannot manufacture bootstrap from an empty directory. The optional
`publication` projection in the existing authority configuration binds these
three immutable public JSON sources and the initial setup/preimage digests under
the same ratified configuration/grant; the complete signing caller requires it.
This source preparation neither fetches private keys nor changes settings.

`release-signing-controller` is the fixed bundled payload/context continuation.
After actual payload signatures settle, it derives that prior and record set,
then opens a second existing pending upload operation for the fixed
`payload-signing-context` output. Only then does it expose the exact two public
upload files. Original opaque provider readback and fresh payload-job OIDC bind
the resulting predicate before journal settlement. It keeps the payload role's
single 570-second working deadline and allocates subsequent observer rounds from
the same private counter, bounded at twelve. Executor identity and dedicated
journal transports inherit that deadline; late write replies remain unresolved.
The context still needs its fixed attestation step and actual five-role
consumers. The sixth tool bundle has local isolated refusal smoke evidence;
its new complete hosted artifact and consolidated job wiring remain pending.
Secret jobs must launch the authenticated bundle rather than install checkout
dependencies or execute the unbundled entry. No role settings are activated.

The dependency-free `release-controller-tool-launch.mts` implements that initial
payload entry. It authenticates the tool artifact with the existing receiver,
requires the running Node bytes to match the authenticated executable and imports
only the fixed manifest-owned signing-controller bundle. That bundle performs
its own actual receiver check to establish its module-private custody; no brand
or acceptance flag is serialized across the boundary. Both acquisitions and the
entire continuation share the original launcher deadline, which the bundle can
only tighten. Local isolated tests load the launcher without `node_modules`,
exercise the real six-entry pack and prove the deadline cannot be extended.
These observations do not qualify protected hosted signing or role execution.

The context artifact preparation additionally requires actual complete public-site
custody matched to that Tough prior. Its fixed two-file ZIP contains a bounded
manifest and packed public bytes; the existing raw ZIP preflight, CRC and exact
ordered file inventory bind the entire context. The producer rechecks the
uploaded opaque archive against the private factory and obtains fresh signed
payload-job identity before preparing the existing custom attestation predicate.
The receiver invokes the pinned GitHub verifier, matches the exact source,
run/attempt, manifest, artifact and completed numeric producer job, brackets
provider readback, and rehashes all retained public proof and context files.
Injected providers cannot mint a private receiver receipt. This transfers pre-sign
context provenance only. Actual callable role orchestration, fresh role controls,
post-sign qualification and publication admission remain separate joins; no
workflow permissions or credential provisioning follow from this preparation.

The actual `assemble-tuf` report additionally returns `publication`: root/offline
anchor hashes, public-only repository/timestamp/snapshot/record hashes, six
canonical decimal-string version floors and exact expirations. These facts are
derived after the maintained stack verifies the assembled signatures, freshness,
content and retained history. The fixed controller binds this actual tool output
to the private assembly session, independently reads back the published bytes,
then attaches the actual operation and provider/whole-site receipt for
`recordPublishedMetadata`. An imported report alone is not publication evidence.

The Windows installer harness has an explicit ordinary-public updater mode,
connected to the existing separate-account driver and normal shipped updater UI.
Its [prepared journey and proof scopes](qualification/slice4-windows-public-update-preparation-2026-10-21.md)
cover exact V0/V1 bytes, automatic relaunch identity, real favorite and preference
preservation, raw local fault preimages, and named recovery. Controlled tests do
not establish the actual Windows public journey or native acceptance. The proposed
signature-subtype component/native proof split requires the single consolidated
conditional grant; no negative public feed or verifier bypass is prepared.
