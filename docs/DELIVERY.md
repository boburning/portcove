# Continuous verified delivery

This is the approved delivery design, not a claim that unattended publication
or the application updater is active. [Releasing](RELEASING.md) retains the
current protected tag/draft/publication procedure until a separately authorized,
implemented and proven replacement is activated. The live
[Project](https://github.com/users/boburning/projects/1) owns scheduling;
canonical issues own acceptance and evidence. Immutable release records own
shipped provenance; catalog data owns actual port availability and support.

## Versions, channels and readiness

Application versions, update channels, capability workstreams and readiness
commitments are independent. Rolling describes frequent delivery; Stable and
Preview are the only application channels. Game channels and catalog delivery
retain their independent contracts. Choosing application Preview never opts
games into upstream previews. Prepared games remain usable offline without an
account, GitHub token, telemetry or persistent device identifier.

Published versions and evidence are permanent. Continue forward from the actual
inventory: after `0.1.0-alpha.2`, possible previews are `0.1.0-alpha.3` and
`0.1.0-alpha.4`; first public beta may be `0.1.0`, then `0.1.1`, `0.2.0` and
`0.3.0`, production candidates `1.0.0-rc.1`, and production `1.0.0`. These are
examples, not required stops. Never reset to `0.0.1` or reuse published versions.

Public 0.x releases are Preview-only and GitHub prereleases, including bare
`0.1.0`, which is not syntactically a SemVer prerelease. Show “Public beta” only
after the beta gate passes. Stable requires explicit production approval;
absence of a suffix, GitHub latest, and a prerelease checkbox are insufficient.
Preview includes eligible experimental/beta/RC and corresponding final releases.
At production readiness, Stable becomes the default for new installations;
existing testers choose Stable or continued Preview once and retain that choice.

Use maintained SemVer parsing and precedence, never lexical or publication-time
ordering. Build metadata is provenance, not an update increment. Normal upgrades
increase versions. Later-published maintenance does not supersede a higher
feature preview. Stable-to-Preview is opt-in; Preview-to-Stable records the
preference and waits for a compatible non-older Stable. Identical installed
versions need no reinstall after eligibility changes. Rollback is separate.

Patch releases contain compatible corrections; pre-1.0 minor releases contain
substantial capabilities or intentional compatibility changes with migration
notes. Major zero permits no silent data loss. At 1.0 define the public contract
and follow normal major/minor/patch semantics. Desktop and CLI continue using
the existing checked Cargo/Desktop/Tauri version authority. Independently test
NSIS, macOS bundle, DEB/RPM and updater version mappings; SemVer alone does not
prove native upgrade behavior.

Deterministic preparation uses reviewed change classification and a frozen
commit, serializes version allocation, and never guesses a version with AI
during publication. Release classification and download-selection implementation
must be corrected and tested before any suffix-free beta ships. Offline
preparation and download selection implement this policy as documented in
[Releasing](RELEASING.md). Production publication still uses transitional
suffix-only classification; its protected integration and activation remain
separate.

Public beta requires usable representative first play/recovery, all four baseline
updater paths, a real updater-enabled release-to-release proof, safe failure and
data preservation, honest limitations, and the provisioned bounded delivery
pipeline needed to keep testers current. Compiling packages or manual reinstall
instructions cannot complete this updater commitment. Incremental previews need
their applicable candidate safety checks; they need not complete the milestone.

The expanded beta commitment also includes the complete finite preparation
boundary (#31), structured presentation/artwork foundation (#208), public CLI
and real Playnite reference proof (#30/#243), and independent catalog delivery
(#245/#397/#398/#246). These are existing owners with their full scoped acceptance,
not requirements to migrate every adapter, provide every artwork asset or build
a marketplace. Application and catalog publishers retain separate authority and
component dependencies; neither parent waits for the other's closure. The later
production package requalification in #46 remains a 1.0 commitment.

1.0 requires the finite outcomes in [Roadmap](ROADMAP.md): unassisted first play,
management/recovery, a user-controlled library, accessible flagship UX, qualified
distribution/upgrades, independently consumable CLI/reference proof, and proven
autonomous catalog delivery. Qualification starts during implementation; beta
safety cannot wait for production qualification. RC stabilizes one exact
candidate's scope/commit, not all concurrent beta development.

## One updater workstream

[#52](https://github.com/boburning/portcove/issues/52) owns shared trust,
selection, host state and UX with platform installation adapters. Prefer
maintained Tauri updater machinery, never a universal installer or arbitrary ZIP
overwrite. The Tauri host owns application replacement and preferences; core
remains authoritative for library/game state, sessions, activity and locks;
React presents typed host results without choosing arbitrary URLs or policy.

Preferred execution order is trust/ownership/compatibility/key/recovery design
(#223), artifacts/signatures (#219), authenticated channel metadata (#220),
host scheduling/staging (#221), accessible UX (#222), Windows proof (#224),
Linux AppImage (#225), Deck Gaming Mode integration/proof (#535), macOS Intel and Apple
Silicon (#226), and consolidated beta acceptance (#52). Early feasibility and
independent fixture work may run in parallel. Order alone creates no dependency.
Design closes on reviewed contracts/test-key fixtures, not on future production
credentials. #46 owns later exact-artifact production requalification; #52 must
not wait for #46 closure. Existing Deck #51/#213–#217 and Steam route #290 retain
their owners; automatic entries #292 and Decky #293 remain optional.

## Consent and safe application

Recommend automatic mode with clear one-time setup consent/disclosure; existing
users choose once. Retain notify-only/manual modes, pause/defer, current version,
channel, progress, optional notes and actionable recovery. Saving preferences
never initiates installation. Automatic mode needs no recurring release-note
approval. Keyboard/controller and assistive-technology paths must work.

Check asynchronously after startup when due, initially at most daily after a
successful automatic check, with bounded backoff/jitter and explicit manual
checking. Download and verify without blocking startup. Apply at safe normal
exit where the platform proves it, without unexpectedly reopening; expose
“Restart to update”. Apply-on-exit is a qualification target. If the maintained
updater cannot provide it safely, automatic download plus one restart action is
acceptable initially; record the remaining improvement instead of adding a service.

Never interrupt games or installation/import/restore/backup/relocation/preparation.
Use authoritative shared cross-process session/activity/lock state, including
separate CLI and Desktop processes. Immediately before application, recheck busy
state, consent, channel, candidate identity/version, ownership and permissions.
Normal Exit, crash, OS shutdown and Steam Stop differ: killed processes cannot
guarantee exit hooks. Reconcile staged intent on next launch and revalidate
withdrawals/eligibility; never execute stale intent blindly.

Offline, metered and manual download controls remain explicit where detection
is unavailable. Bound staging/download/cleanup and preserve recovery assets.
Unreachable, stale, incompatible and held states differ; a target without an
eligible candidate must not receive another installer or a “fully current” claim.
Failed/expired checks never disable offline application use.

## Platform contracts

| Baseline   | Installation and qualification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows    | Existing NSIS, explicit current-user writable application storage, Tauri-verified installer and supported passive mode. Inventory system-wide/custom installs; preserve identity, shortcuts, registration and data without silent relocation/duplication. Qualify ordinary upgrades without administrator rights; handle elevation/permissions accurately and WebView2 setup/repair separately.                                                                                                                                                                                                  |
| Linux      | User-writable AppImage, maintained replacement, stable local launch target, immutable public versioned artifacts. Preserve executable bits, desktop integration and data. Qualify declared distro/glibc/WebKit/graphics/FUSE, permissions, disk and noexec limits. No universal Linux compatibility or unproven symlink/current-pointer scheme. DEB/RPM remain package-manager-owned; without a proven repository/integration, direct users to accurate manual/package-manager updates, never overwrite their files.                                                                             |
| Steam Deck | Same Linux x86-64 application/AppImage, early bounded SteamOS feasibility, user-owned home storage and stable absolute launch target. No hard-coded user, Gaming Mode PATH assumption, sudo/pacman, read-only-protection change or Decky. Desktop Mode setup is allowed; routine qualified updates work in Gaming Mode with controller. Preserve Steam entries, targets, artwork, controller choices and independent per-game launch routes. Exercise real launch/focus/process, Exit versus Stop, next launch, suspend/network loss and internal/removable storage. Linux CI is not Deck proof. |
| macOS      | DMG bootstrap, then maintained installed-bundle updating with ad-hoc code signing plus mandatory updater signatures. Preserve bundle identity/structure/permissions/signature validity. Qualify Intel and Apple Silicon separately using installed executable/translation context. Detect disk-image, translocated/read-only, moved and unwritable installs; guide permanent user-writable installation without assuming /Applications is writable. Test initial Gatekeeper and subsequent updates under normal security settings; retain a future Developer ID bridge.                          |

Updater signatures, SHA-256 reconciliation, OS-recognized publisher
identity and OS enforcement/permissions are four distinct claims. Quiet/passive
installation is not a security-prompt bypass. Ad-hoc signing does not promise
Gatekeeper approval; paid signing does not guarantee prompt-free installation.
Never make disabling Defender/Gatekeeper or stripping quarantine the normal path.

## Trust, ownership and recovery

[Updater trust and recovery](UPDATER-TRUST.md) specifies the maintained metadata
format, key lifecycle, bounded transport, compatibility and recovery design with
disposable test-key fixtures. It does not activate production update behavior.

Every artifact has a mandatory Tauri signature. A small separately authenticated
metadata contract binds immutable release/hash/version/target/package/compatibility
identity and channel eligibility. Authenticate promotion separately so existing
bytes can become Stable without rewriting them. Payload signatures do not
authenticate arbitrary feed JSON; HTTPS and adjacent checksums are insufficient.
Use maintained cryptographic formats/libraries, separate from catalog execution
authority. Define replay/freeze limits, constrained origins/redirects, bounded
parsing/extraction and old-client behavior; metadata failure blocks new updating,
not offline use.

Plan an automation-capable protected release key, offline recovery backup,
separate production/test keys, tested recovery/rotation bridges, compromise and
loss procedures. Ordinary PR/build jobs receive no production secrets. Trusted
signing binds an eligible commit/workflow/run to exact inventory and never runs
candidate application/build scripts with signing/publication credentials.
Offline clients cannot instantly learn revocation; a lost sole key cannot be
magically recovered through its own trusted channel. Provisioning is a separate
one-time authorized action, never a prerequisite for test-key design work.

Each installation has one updater owner: Portcove, package manager or explicit
manual path. No silent package/channel/architecture switch or overwrite of an
independently installed CLI. Inventory companions rather than assuming bundling.
Separate product version, CLI protocol, catalog format, capabilities, minimum OS
and database compatibility. Define supported mixed CLI/Desktop versions, refuse
incompatible shared-state access, retain necessary bridge releases/endpoints for
skipped versions, and prevent accidental mutable-data sharing between channels.

Bound staging, verify disk/permissions/paths/links, exclude concurrent mutations,
and use recoverable platform replacement. Native installers are not universally
atomic and Tauri is not a complete rollback system. Retain the immediately
previous successfully installed signed compatible eligible version where safe.
Prefer forward repair after withdrawal; a valid old signature alone does not
prove schema compatibility. Test transactional migrations. Binary rollback must
not restore stale library state or erase newer saves. Keep libraries, ROMs,
installations, saves, backups, settings, artwork and credentials outside replaceable
payloads. Unsafe downgrade offers data-preserving repair/reinstall even when the
new GUI cannot start.

## Independent catalog and game delivery

#245/#397 own accepted design and compatible loading; #398 observes configured
upstreams; #246 proves a new compatible definition, its next routine artifact
and a safe correction reaching an unchanged compatible client with zero
per-candidate owner actions after provisioning. This is an explicit Public beta
gate, cumulative through 1.0, not a dependency of the updater. Keep embedded catalog
delivery until its successor ships. Definitions requiring new capabilities are
held clearly; they cannot introduce arbitrary execution or updater trust.
Never reduce catalog breadth or require personal gameplay for every entry.

## Bounded release automation and cost

#532 owns deterministic version/classification implementation, #533 the bounded
pipeline, and #534 separately authorized one-time production provisioning and
proof. They reuse #219/#220 and completed #524 instead of replacing their owners.

Extend the current pipeline: reviewed change/fast checks, prepared exact
version/commit, secret-free builds, complete declared inventory and applicable
package/upgrade checks, protected signing, draft assembly/independent verification,
immutable publication, authenticated channel promotion, public readback. Arrange
signing/packaging according to native requirements and verify final distributed
bytes after every byte-changing operation. Build once per exact candidate;
rebuilt artifacts require fresh qualification. An RC and suffix-free final with
different embedded metadata are different artifacts and evidence identities.

Use immutable GitHub Releases for large artifacts, generated static per-target
feeds on GitHub Pages where available, and standard public-repository Actions
within free limits. A Tauri static feed has one top-level version: different
eligible versions across targets require separate feeds. Missing required package
outputs fail publication; target promotion may hold a previous qualified version.
A shared Linux payload advertised to Deck needs applicable Deck evidence.

Initially coalesce at most one meaningful routine Preview release per day.
Stable fixes/features ship when ready, without a weekly obligation. Urgency
bypasses cadence only. No release for every merge or documentation-only change.
Use trunk and short-lived preparation PRs, bounded maintenance/backport exceptions,
deterministic reviewed notes/classification and no long-lived channel branches
by default. Implement idempotent retries, concurrency exclusion, exact-SHA/run
binding, feed reconstruction, partial-promotion recovery, failed-candidate
retention and authenticated withdrawal without modifying published assets/tags.

Every release needs exact classification, required checks/review, complete
inventory/signatures/hashes, applicable packaged bootstrap/upgrade/smoke and
preservation tests, compatible feeds, readback and accurate evidence/notes.
Relevant installer/migration/runtime/permissions/controller/Gamescope/OS changes
trigger expanded physical tests when prior evidence no longer applies. Milestone,
new support and major trust changes need broader representative qualification,
production rehearsal and intrinsically required hardware/human observations.
Record applicability rules; do not require personal hardware testing of every
patch or assume old evidence is always reusable.

Keep fast secret-free PR gates; use cached, bounded release/rehearsal lanes for
expensive work and short transient retention. Standard public runner eligibility
does not make storage/cache/larger runners free. Hold/retry when free limits are
reached; no paid overages, metered AI, Jenkins, custom server, mandatory self-hosted
runner, always-on service or generic privileged updater service is authorized.

After one-time policy/credential provisioning and demonstrated refusal/recovery,
routine releases and promotions should run unattended with quiet success and
deduplicated actionable exceptions. Merge, tagging, publication and promotion
remain distinct authorities. General autonomous engineering #284 is not required.
Security-sensitive changes, exceptions and production declarations retain the
relevant owner decision. Current protections remain effective until replacement.

The baseline adds $0 in service/certificate fees, not zero engineering, custody
or hardware effort. Authenticode and Developer ID/notarization are optional
installation-trust improvements, independently authorized in response to measured
support burden. Flatpak, extra formats/architectures, repositories, deltas,
percentage rollouts, CLI self-update, Steam entry automation and Decky are outside
the baseline. No paid signing or recruitment quota blocks updater completion.

## Implementation evidence

Require manual bootstrap from a genuinely updater-less release, then actual
updater-enabled N-to-N+1 and skipped-version paths. Exercise public-beta-to-1.0,
Preview-to-final, Preview-to-Stable waiting, beta.9/beta.10, suffix-free 0.x,
out-of-order maintenance publication, incompatible OS/architecture/package and
old-client bridges. Exercise wrong/missing signatures, metadata/artifact tamper,
replay/stale/withdrawn feeds and staging, redirects, corrupt/truncated downloads,
offline/rate limits, disk full/read-only/noexec, cancellation/crash/reboot/Steam
Stop, busy-process races, duplicate/interrupted publication, incompatible rollback,
stable targets and recovery without the GUI.

Bind results to commit/tree, final package hashes/signatures, feed identities,
OS/architecture/ownership, inputs and observed outcomes. Record return, recovery,
prompts/actions, preservation and owner intervention through local diagnostics.
Fixtures, packaged processes, VMs, physical automation, gameplay and human
comprehension are distinct evidence. Missing hardware blocks its required proof,
not unrelated implementation; complete beta stays open until every baseline path
has actual evidence. No telemetry, install count or fixed waiting period substitutes.

## Reference verification — 2026-09-08

The repository pins Tauri CLI 2.11.4 and framework 2.11.5 in Cargo.lock.
No updater plugin is installed and createUpdaterArtifacts remains false. The
current Tauri 2 documentation is design guidance; implementation must pin the
maintained plugin and verify its precise native behavior. Apply-on-exit and
free-baseline Gatekeeper/Deck behavior remain qualification questions.

- [SemVer 2.0](https://semver.org/) defines precedence and initial development.
- [Tauri updater](https://v2.tauri.app/plugin/updater/) documents required signatures,
  static feed shape and Windows install modes; [NSIS](https://v2.tauri.app/distribute/windows-installer/),
  [AppImage](https://v2.tauri.app/distribute/appimage/), [Linux signing](https://v2.tauri.app/distribute/sign/linux/),
  [Windows signing](https://v2.tauri.app/distribute/sign/windows/) and
  [macOS ad-hoc signing](https://v2.tauri.app/distribute/sign/macos/) distinguish native paths.
- [Microsoft SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
  and [Apple Gatekeeper](https://support.apple.com/en-us/102445) describe OS enforcement;
  updater authenticity cannot promise to bypass it.
- [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
  [release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
  [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
  and [release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
  support bounded free infrastructure, with availability/usage rechecked at provisioning.
- [Valve Desktop FAQ](https://help.steampowered.com/en/faqs/view/671A-4453-E8D2-323C)
  did not return substantive text to this research client; existing #290 evidence
  is retained and real Gaming Mode proof is still required. [Flatpak permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
  reinforce its separate optional ownership/sandbox qualification.
- [Artifact Signing SKU](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)
  and Microsoft's SmartScreen page list Basic at $9.99/month;
  [Apple membership](https://developer.apple.com/programs/enroll/) lists $99/year
  (about $218.88/year combined before taxes/overages). Reverify eligibility/pricing
  before any future optional purchase. [SignPath Foundation terms](https://signpath.org/terms)
  require manual approval for every release, so it is not the default autonomous path.
