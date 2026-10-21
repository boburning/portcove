# Ordinary Windows public updater preparation — 2026-10-21

This is source preparation for #534 under the proposed consolidated conditional
setup grant. No account logon, GUI launch, public download, updater application,
publication, Check issuance or native acceptance is established by this change.

## Connected entry and custody

The existing `scripts/test-windows-installer.ps1` accepts an explicit
`OrdinaryPublicUpdateInputsPath`, its SHA-256 and the original parent's remaining
lifetime. It requires the existing isolated account binding and
`NativeParentOwnsFinish`; private keys, renderer fixtures, alternate feeds,
ordinary-package fixture manifests and package rollback modes refuse. Its default
pre-sign and package compatibility paths are unchanged.

The bounded, digest-pinned input has exactly these fields:

```json
{
  "schema_version": 1,
  "kind": "ordinary-public-windows-update-inputs",
  "prior_installer_sha256": "<actual appointed public V0 NSIS SHA-256>",
  "prior_executable_sha256": "<actual appointed V0 installed executable SHA-256>",
  "prior_version": "<V0 version>",
  "candidate_installer_sha256": "<actual public V1 updater payload SHA-256>",
  "candidate_executable_sha256": "<actual appointed V1 executable SHA-256>",
  "candidate_version": "<distinct V1 version>"
}
```

These are expected byte identities supplied by the fixed parent from genuine
public release/package evidence. The JSON is data, not native acceptance or
publication authority. It cannot appoint metadata origins, keys, qualification
environment fields or product markers. Current-account and machine registration
preflight remains the existing installer refusal; the selected V0 installer and
its exact version must match before installation. The script derives the actual
registered installed path, then creates the small fixed Node configuration in
owner-only capture storage. The existing Windows updater harness dispatches
`--ordinary-public CONFIG SHA REMAINING_MS` before its legacy marker route.

`DesktopNativeAccountSession` remains the sole driver/application process
transport. This invocation needs a fresh public-journey broker binding, not a
reused `desktop-driver-N` namespace from an earlier desktop-test instance. Every
candidate/driver/helper remains in its existing bounded account/job group. The
fixed outer parent retains the sole group-finish responsibility.

## Ordinary behavior to observe

The driver creates a fresh isolated Core library/preferences/staging scope and
selects one real entry from the current Gen2 catalog as a favorite through the
shipping Core command. It chooses Light using the ordinary Settings UI. Neither
operation claims an installed game, save compatibility or arbitrary definition
admission.

The ordinary packaged WebView origin is `http://tauri.localhost`; this is the
application's existing asset protocol, not a substitute updater feed. Updater
metadata/targets stay at the compiled public origins. No qualification feature,
IPC hook, supplied root/URL, process marker or fixture environment is passed to
the product.

Pinned Tauri 2.12.4 uses `app_local_data_dir()` as its default Windows WebView data
directory. Pinned dirs 7 / dirs-sys 0.5 resolve that through
`SHGetKnownFolderPath`, not an overridden `LOCALAPPDATA`. The driver uses the
bound actual profile's ordinary `AppData/Local/io.github.portcove.portcove`
directory and independently checks the shipping `plugin:path|resolve_directory`
result before any UI/Core mutation. Redirected or different known folders refuse.
The shipping app-version command is also read; a different compiled version
cannot satisfy V0 or V1.

The first public V1 staging is checked against the exact expected installer hash.
After natural V0 close and positive owned-tree teardown, the harness retains raw
journal/payload bytes and flips one byte in that fixed local staged payload.
Before reopening, it retains the changed raw bytes again. The actual ordinary
staging recovery notice and named UI control must refuse/clear that local
custody failure while installed V0 and user state remain. This leg does not
identify a cryptographic error subtype. V1 is then downloaded and verified again
through the ordinary public UI.

After the ordinary Restart button, the original V0 process must disappear and a
distinct kernel-observed PID/creation identity must appear at the installed path
in the same owned job. Exact V1 file bytes bracket the observation. Its native
main window receives one identity-bound close request and must exit naturally.
Only then does a separate normal V1 driver launch read back the actual compiled
version, library/favorite identity, appearance and updater choice. This later
launch cannot substitute for automatic relaunch observation.

The driver next exercises one malformed schedule, staging and apply journal in
turn. Each mutation follows positive owned-tree settlement. Raw originals and
fault bytes are retained before startup or status queries, which can perform
ordinary product staging reconciliation. Only the named existing UI recovery
control is clicked; unrelated recovery holds/staged/apply state must remain.
Favorites, library selection, appearance and updater choice are checked again.
Preference revisions and updater journals may legitimately change. The existing
installer finally checks V1 registration/bytes and performs its ordinary owned
uninstall/registration cleanup.

One inherited monotonic lifetime is tightened through configuration reads and
the driver; startup, automatic relaunch and natural-close polling have finite
sub-budgets. The existing broker's 64-root/task and 512-operation refusals remain.
Raw preimages allow at most seven fixed files per capture: five one-MiB files
and two 512-MiB payload files. Copies are component bounds, not storage reservations
or observed headroom; actual native timing/storage and account containment remain
qualification obligations.

## Prepared cryptographic-proof amendment

No production negative-feed publisher or origin/TLS bypass is proposed. The
shipping payload verifier checks length and SHA-256 before signature finalization.
Changing staged bytes therefore reaches a hash/custody refusal, while the ordinary
UI intentionally projects a sanitized verification failure. UI text cannot prove
`SignatureMismatch`.

The prepared proposal for the **single** final conditional grant is to compose
three separately attributed legs: ordinary public V0-to-V1 native application;
ordinary native local-tamper/refusal and named recovery; and the actual shipping
Rust verifier over independently authenticated public V1 bytes/exact V1 length
and hash, paired with V0's public signature under the same public key, requiring
the exact `PayloadVerificationError::SignatureMismatch` variant. No new signature,
private key, public negative release or owner exception is needed for that
component input. The current shipping Rust tests already distinguish that exact
variant from `HashMismatch`; the generic packaged verifier's wrong-signature
report alone does not prove the subtype. The actual public-byte component run
and any narrow strict-verifier entry remain to be qualified before credit.

This is an explicit proposed proof amendment, not a silent replacement of native
cryptographic-subtype evidence. Acceptance remains pending unless the owner
selects the precise split in the consolidated grant. Genuine withdrawal/forward
repair publication and the ordinary public journey still require their actual
guarded publisher/driver observations. #706's existing one-release Linux budget
does not authorize a second beta: remediation or an explicit bounded two-tag
proposal remains a separate decision, with the current expiry and scanner facts.

## Current checks

The forward-repair connection now allows the existing explicit restart command
to supersede an older pre-native restart request with a strictly newer staged
candidate on the same installation, library and channel. The actual apply lock
and journal revision exclude an admitted helper or fence its old request; this
does not establish process-tree teardown. Every recorded native attempt remains
under its original reconciliation rules. No generic clear command, malformed
journal or new trust authority is used. A separate ordinary UI staging function
retains the exact old sanitized request while downloading the new candidate;
its caller must independently retain raw intent, installed identity, fresh
public source and positive helper settlement. It cannot supply those facts.

Nine controlled UI/actual status-reader tests pass, including changed and
ambiguous old-request refusals; two changed TypeScript files pass type-aware
lint. The new Rust regressions exercise actual apply/staging/preference locks,
old-revision refusal and ordinary new-candidate admission, plus preservation of
recorded native and unrelated intents. Their execution is recorded by the
change's exact-head required Rust checks, not by the UI fixtures. No actual
native account, public artifact or updater execution is claimed by this change.

Controlled Node/PowerShell preflight, real temporary-file custody, alias/reparse
refusal, identity comparison and actual serialized ordinary-query callback tests
exercise engineering behavior only. They launch no candidate, account session or
GUI. Actual Windows host/runtime, public artifacts, network, updater replacement,
post-public journeys and native acceptance are unobserved here.

The final focused local run passed 17 cases with zero skips (ten Windows public
entry/filesystem/query tests plus seven shared ordinary stage/recovery tests).
The validation-plan/index run passed 18 cases; seven changed TypeScript files
passed resource-admitted type-aware lint. Earlier resource-wrapper path failure
ran no lint; subsequent typing failures exposed floating test promises and an
untyped observation array, both repaired before this successful check. These
feedback results confer no account, native-host or public-artifact acceptance.
