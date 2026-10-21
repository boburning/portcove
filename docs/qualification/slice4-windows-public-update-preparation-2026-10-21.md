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

## Public-parent source custody in preparation

A separate source checkpoint prepares the protected installed parent connection.
An explicit schema-2 descriptor proposes the fixed initial-cohort profile plus
one public-build configuration identity; schema 1 keeps its original behavior.
The descriptor carries no version, tag, executable hash or accepted-result flag.
Its actual installed task, source, protected bytes and setup-grant checks remain
mandatory. No descriptor or host setup has been changed.

The new actual-default source callable reuses the parent's existing pinned
read-only GitHub transport. It recovers the current journal's published seed,
materializes the complete exact public site, and invokes the maintained pinned
Rust/Tough verifier. It binds Root, offline Targets and payload registry to the
protected publication configuration. The first two namespace allocations with
eligible published records must match exact prepared source/tree; failed or
retired allocations without such records do not consume either slot. Inconsistent
records or immutable Release assets still refuse. Current eligible
Preview must still equal V1, and both versions and package bytes must differ.
Opaque package acquisition brackets a complete immutable Release/asset inventory
and retains exact hashes. Imported JSON cannot enter these private custody maps.
These are source/package facts, not native acceptance or compiler observations.

This checkpoint is not a standalone delivery or the final parent connection.
Local-parent compiler attestation collection, durable attempt custody, the hard
outer supervisor, public capture/report handoff, installed setup renderer and
worker routing are still being joined. The worker must preserve the existing
native pre/post-sign path while a candidate is active, then select the public
cohort automatically; replacing it at initial setup would prevent V0/V1 release.
The V0-to-V1 route does not complete the later withdrawal/forward-repair proof.

The focused source/association/refusal selection passed 20 cases, with the one
existing optional keyless-tool fixture skipped on this invocation. Type-aware
lint passed all five changed TypeScript files after four ordinary draft typing
diagnostics were repaired; retained logs preserve the original result. These
checks invoke no native account, installer, GUI, provider mutation or public feed.

The next source increment reuses the existing compiler report parser and
attestation inspector through the same parent-owned pinned GitHub transport.
It generates the complete compiler-source closure from the protected local
controller with its pinned Git executable, verifies the real four-file prepared
transform and original source tree, then checks the actual producer run, complete
four-report subject matrix, independently appointed public-build bundle and the
single NSIS package against the Tough record. The protected local workflow bytes
supply the expected workflow digest. The public bundle Root/payload key must
match the actual published pair. Report ZIP parsing is mechanically shared with
the hosted collector; injected/hosted scope and the hosted private getter remain
unchanged. A separate local private map retains all raw reports, original ZIPs,
public bundle archives, verification output, provider facts and source closure.
It cannot be populated from imported hosted/local summaries.

The deterministic cohort rule skips failed/retired allocations lacking eligible
public records. A later unpublished allocation can proceed without changing the
selected pair; every getter still reconstructs the exact same pair from complete
current allocation facts and requires the same published seed. Current Preview
or selected source/record drift continues to refuse.

The final focused source/parser/import-refusal selection passed 11/11 with zero
skips; type-aware lint passed eight changed source/test files before the final
mechanical removal of a redundant whole-allocation-list comparison. The first
new ZIP fixture accidentally supplied objects to the existing tuple-based helper
and failed before parsing; its log is retained alongside the corrected run under
`work/windows-public-update/`. This does not qualify an actual local-parent,
GitHub, compiler, installer or public updater execution. The actual attempt,
parent dispatch, supervised driver and cross-invocation public proof remain
unfinished and must be connected before this branch is delivered.

## Protected attempt and initial Windows caller preparation

The source now joins the actual protected parent, published pair, materialized
package and local compiler receipts to the existing setup-created native custody
anchor. Public phases use the same `native-attempt-<digest>` leaves. Their
identity includes the actual checkpoint/capacity digest without creating or
resetting coordinator retry counters. Imported summaries cannot mint this claim.
Historical native attempts require positive original local root/group teardown
and retained streams; this passive resource check neither resolves nor repeats
an ambiguous Check POST. A completed public A advances only to the parked B
phase; completed B waits for genuine V2 continuation, and failed or incomplete
local settlement refuses reuse.

The fixed Windows worker now routes an actual inactive reservation plus the
protected public profile through the existing original-lifetime supervisor into
the ordinary installer/UI entry. The legacy active-candidate stage path remains
separate. The actual public getter binds the sole bridge finish, original child
handles, exact candidate root creation/teardown, automatic V1 executable bytes,
meaningful user state and all three named recovery observations. Its technical
settlement is created only from that private capture getter, with no raw accepted
JSON constructor or Check/report2 authority.

Ordinary retained files keep their 4 MiB bound and 512 MiB combined bound. The
existing Windows preimage helper has ten fixed snapshots with two fixed payload
slots each; only those exact paths retain the existing 512 MiB payload bound.
This is a streamed recheck of already-retained raw bytes, not an additional copy
or a storage reservation. Linux's original bounded wire remains separate from
its enumerated small exported files. Available disk and actual native behavior
remain unobserved. Original compiler/package/public-source evidence must be
acquired within the provider's seven-day retention window; later phases must
retain the genuine original bytes and must not rebuild expired evidence.

The new source/phase/import-refusal selection passed 29 tests with zero skips;
the Windows driver selection passed six actual inert PowerShell/process tests.
The initial driver run had four passes and two fixture failures: a nested
hashtable differed from real JSON objects, and the old stage fixture omitted its
real schema field. Both fixtures now model the real input and retain their old
negative assertions. Typed checks passed after explicit proof-outcome narrowing
and removal of one unnecessary test assertion. A further real-filesystem check
passes for empty streams, a streamed 5 MiB preimage, oversized input, hardlink
alias refusal and expired original-clock refusal. No account, installer, GUI,
namespace, public publication or native acceptance execution occurred.

The initial public Windows route is connected in source. Parked B, original
historical evidence under a changed V2 feed, and full withdrawal/forward-repair
continuation are still held. These are required remaining engineering before a
consolidated setup can be treated as ready; V0-to-V1 alone is not the full proof.

The next source increment connects the derived `park-v0-with-v1` phase through a
closed schema2 child input. It uses the ordinary UI to stage genuine public V1
while V0 remains installed, retains meaningful state/raw staging preimages,
positively closes the owned application tree, and preserves that installation.
Only this fixed phase returns before uninstall; schema1 A keeps its original
apply/relaunch/recovery/uninstall route. The actual parent getter additionally
binds the retained V0 executable, V1 staged identity and current-user installer
registration before recording technical phase settlement. Eighteen inert
configuration, file, PowerShell and driver checks passed with zero skips, and
six changed TypeScript files passed typed lint. No installer or account ran.

The later V2 continuation is still held. In addition to original evidence
retention and current Tough withdrawal/forward-repair readback, the setup needs
a concrete rendezvous: V2's native qualification currently uses the same Windows
account/product registration and could alter B's parked V0 before V2 publication.
Positive process settlement does not isolate that durable registration. This
source increment does not appoint another account, relax native gates or claim
that scheduling conflict resolved.

The current-record association helper now shares the original immutable-release
parser with the initial selector. It can reconstruct the precise original pair
under a retained cohort digest after V1's promotion is withdrawn, require the
actual V1 withdrawal, and identify only the first genuinely published eligible
newer V2 while refusing later Preview drift or a required bridge. This helper is
data-only and does not supply the still-required actual protected historical
claim, compiler/package retention or parent/capture continuation. Six focused
pair cases and typed checks passed. The first new test wrongly expected the
initial selector to refuse V0/V2 reselection; its corrected assertion explicitly
proves that reselection changes the retained pair digest, which is why the
continuation requires the original protected marker.

The historical local getter separately recovers only an actual protected
parent's completed A/parked-B prefix, rehashing original markers, capture roots,
streams and retained files. It has no raw constructor or current-policy/native
acceptance capability. Later appended attempts do not rewrite that historical
fact; a new resource claim must still establish its own complete current
settlement and policy before execution. Imported-parent/cohort refusals and the
existing phase contracts pass, with typed checks. The actual current-Tough/V2
factory and its new invocation join remain unfinished.

The current-source continuation factory now accepts only that private retained
cohort receipt, acquires a fresh complete published site and actual keyless
Tough preparation, and independently rederives the exact withdrawal/V2 graph.
Its package custody reuses the original protected B input bytes for V0 and V1;
missing old bytes refuse instead of downloading or rebuilding a replacement.
V2 still uses fresh immutable Release association, and all three slots bracket
provider readback and hash the exact retained bytes. Eleven pair/phase cases
and six affected typed modules passed. These are source/refusal checks, not an
actual provider or native continuation. Historical compiler provenance, the
new execution claim, the Windows registration rendezvous and V2 capture remain
required before this path can execute.

Original Windows compiler acquisition now writes a bounded fixed retained-input
manifest containing the already verified executable/package/source/run identity
and exact original proof-file inventory. Its raw SHA is part of the identity
whose digest the protected attempt marker already binds. The historical path
requires the actual private continuation pair and completed B receipt, checks
that original admitted digest before rehashing every retained proof, and compares
the source/run/package again to current Tough history. It never redownloads old
compiler artifacts or admits a manifest on its own. Missing, changed or legacy
unmanifested inputs hold. This source preparation precedes any public attempt;
no existing actual public claim was migrated. Fifteen focused data/refusal cases
passed with zero skips and five affected modules passed typed lint. The first
typed draft exposed unknown-valued parser fields; explicit validated return
values fixed that diagnostic without a cast. Actual positive historical-provider
and native execution remain unobserved.

The shared actual invocation claim now has an explicit continuation branch. Only
an actual current continuation pair plus its historical receipt can turn the
complete positive A/B history into continue-with-v2. It still requires no active
coordinator candidate, complete current local resource settlement, original
parent lifetime, and the same exclusive anchor/CreateNew append. V2 requests
separately pin parked V1 package/compiler identities and the exact original B
invocation. The private getter returns those opaque package/compiler references
and rereads the original settled B files/wire; copied phase data cannot claim.
A completed third phase is recognized without replaying it, while the historical
getter continues to pin only the original A/B prefix. Sixteen data/refusal cases
and five affected typed modules passed. Execution dispatch/capture continuation
and the shared Windows registration rendezvous remain held; this claim is not
an observation that a public updater ran.

The fixed Windows capture also retains exact copies of the shipping signature
component's config, registry, raw stdout and empty stderr under its own attempt
root. The actual component getter remains mandatory; copied files are compared
against its original retained bytes on every capture read and enter the existing
complete settlement file inventory. This preserves explicit component evidence
for a later wake rather than relying on a vanished private receipt. Nine scoped
contract/refusal cases and two typed modules passed; they did not invoke a real
parent or exercise a positive native signature subtype.

Independent composition review found and repaired a registration omission: the
shared compiler ZIP decoder now selects both hosted and public compiler tests
and release-security ownership. An actual helper-only classify/plan regression
passes, along with twenty-two existing routing/plan checks and typed lint.

A further cross-contract source trace found that the fixed Windows driver passed
its work root as installer TestBase, while the maintained account adapter guard
requires a strict descendant. The actual argv now selects only the fixed
installer child; the guard remains unchanged. The regression evaluates the
actual driver argument assignment against the actual installer guard and proves
root equality/sibling refusal. Its first extraction lacked PowerShell's lexical
script-directory binding and failed before guard evaluation; the fixture now
supplies only that source-directory binding. Eight driver checks passed with
zero skips on Windows, with typed lint. No account, installer or application ran.
The V2 continuation still needs its exact retained-work invocation and the
separate publication/registration rendezvous.

## Shared Linux settlement connection

The shared attempt module now records Linux public settlement only through the
actual private Linux capture getter. It preserves the original group/root
closure, separate full wire identity, all ordinary exported paths (prefixed
only with guest-capture/), every profile manifest/chunk, and the fixed local
plan/request/registration/host-readback inputs. Recognized hidden atomic JSON
aliases stay covered by the original complete wire rather than invented normal
filenames. Existing 512-file, 4 MiB ordinary-file and separate 272 MiB wire bounds
remain unchanged; an oversized combined inventory refuses. Only exact observed
or parked reports with actual driver status zero and no failure can advance.
Other positively settled observations retain refused scope. The original
CreateNew/fsynced settlement path is shared with Windows and rehashes retained
files/wire before return; actual claim/capture getters are checked again.

Parent phase routing separately inspects the complete setup-owned anchor before
selecting initial/parked/await-V2/completed. Missing or contradictory history
throws; it does not become a catch-and-fallback initial run. Eighteen focused
contract/refusal checks and four typed modules passed; these do not establish a
positive Linux host, namespace, GUI, public-origin or native acceptance run.
The source dependency composition preserves the exact reviewed Windows caller
and incorporates the reviewed Linux capture/forward-repair source, including
root's still-separate safe restart-supersession patch. No remote or host effects
were performed by this connection work.

The installed worker now consumes that explicit parent-phase route. Linux initial,
parked and genuine V2 continuation each use their actual private pair, package,
claim, capture and settlement consumers; parked V1 remains a distinct opaque
input for V2. Completed history returns without a launch, and contradictory
history propagates refusal. Windows initial/parked paths retain their compiler
requirements; its unconnected V2 capture refuses before claiming an invocation.
The actual worker module was imported in a fresh builtins-only child with all
provider/native dependencies mocked: initial/parked/continuation ordering,
completed idempotency, contradictory-history refusal and Windows continuation
HOLD all passed. This is dispatch coverage only and cannot mint a real factory
brand or native observation. Thirteen focused tests and three typed modules
passed; actual host/setup/public acceptance remains pending.

## Proposed dedicated Windows public boundary

The retained B registration collision has a concrete proposed isolation boundary:
one additional non-admin public-proof account, provisioned once under the final
consolidated initial setup grant. Source now requires its separately hash-pinned
boundary in the Windows public profile, inside protected controller staging.
SID/name/profile/work must differ from the primary native account; both root
ancestry directions and Windows canonical/case identity are checked. The broker,
controller, helper and owner-only capture remain shared and exact. Primary
native stages and their global qualification/Check identity stay unchanged.
Public capture/registration expects the selected public SID and profile.

The existing scheduler reader observes the extra owner-held boundary file and
actual local-account/profile registration, protected isolated profile/work ACLs
and HKU-loaded state. Candidate-writable roots cannot overlap either protected
custody or the other account's roots. The actual helper still checks the loaded
profile, SID/non-admin token, private desktop, process group and live public HKU
inside each capture. Its closed credential-purpose selector preserves the
primary target by default and gives the public account a second fixed broker
Credential Manager target; no arbitrary target or password enters a request.

Actual initial setup still requires an authorized operator to create the local
non-admin account, establish its profile, configure isolated work/profile ACLs,
store the separate credential under the ordinary broker and pin all resulting
SID/path/hash/task/source records. Both account directions must actually refuse
cross-writes, and actual logon/profile/HKU/private GUI/group teardown must be
qualified. This work performed none of those OS actions. It adds no App, Check,
coordinator journal, publication barrier, active-candidate relaxation or recurring
admin/user step. The Windows V2 execution path remains the next source join.

Initial focused checks retained two old-public-fixture failures because their
new boundary pin was absent; those fixtures now model the explicit proposal.
A new enum-negative fixture first failed while PowerShell rejected the invalid
cast before the C# selector; Enum.ToObject now reaches and proves the selector's
own refusal. The controlled ACL fixture first omitted the Force switch type;
that fixture-only declaration is repaired. Those failures are retained, with
no positive actual account or ACL observation inferred from the controlled tests.

Final focused validation passed 27 setup/parent/scheduler/driver checks plus the
separate compiled closed-credential-selector check, all with zero skips; eight
affected TypeScript modules passed typed lint. The compilation/controlled ACL
objects did not read credentials, log on another account or query its real ACLs.

Independent review found an ancestor replacement gap in the first boundary
preparation: a foreign ancestor owner could rewrite its DACL without an explicit
allow ACE, and object DELETE had been omitted. Both public-root and shared
owner-path readers now require trusted ancestor ownership and refuse foreign
DELETE rights. The public account itself is trusted only at its appointed root,
not at ancestors. Controlled actual-function fixtures cover foreign owner with
no ACE, public-account ancestor ownership and foreign/public DELETE, plus both
shared-reader cases. The first expanded fixture failed because its script-level
loop variable replaced the root-owner stub; restoring that stub before the
shared baseline fixed the fixture. All six scheduler checks then passed with no
skips, and its TypeScript test passed typed lint. No actual account ACL query or
mutation was performed.

The Windows V2 continuation reader now recovers only the original positively
settled B account binding, installer and public journey report through the actual
current private continuation claim. It rehashes those original settlement files,
checks the newly appointed public SID/profile/controller/helper, and derives only
the original exact invocation work child, installer run/install/library paths,
ordinary runtime and HKU registration leaf. Foreign account, sibling/aliased
work, relocated application/runtime and changed parked identity refuse. This is
an inert path/custody prerequisite; it does not launch, restore, install or grant
an account capability. Three controlled path/private-import-refusal tests and
two-file typed lint passed. Initial lint feedback on control-character regex and
boundary-record narrowing was repaired without expanding accepted paths. Actual
PS/Node continuation execution remains under engineering and is not enabled.

### Windows parked-B continuation source connection

The later `continue-with-v2` claim now connects to the same ordinary Windows
installer/UI route. It selects the separate protected public account and derives
only its original positively settled B work/run/install/library/runtime paths.
The new invocation still owns a fresh capture, broker, profile keeper, process
group and original lifetime. Before any application startup it verifies the
single exact public-HKU V0 registration, V0 compiler bytes and retained
uninstaller hash. It does not reinstall V0, seed a library, write a new marker or
copy a profile. Initial/native branches keep their original fresh-install guard.

The ordinary UI attempts the parked V1 Restart once. The parent requires a new
owned V0 application generation, exact V0 installed bytes and a visible window
with the shipping title, then closes that exact GUI application and settles its
owned tree. A new read-only broker operation observes only a PID/creation pair
already in that same job, brackets it with actual job membership and held-process
creation checks, and reads its private-desktop title. A same-image updater helper
cannot satisfy the GUI observation; it remains in the full settlement inventory.
Raw post-restart apply state must retain the valid old request with no native
launch, replacement or exit. After reopening V0, the maintained ordinary forward
repair UI downloads V2 while preserving that old request; one Retry Restart must
produce actual V2 bytes/new GUI generation before a separate normal V2 UI reopen
and meaningful favorite/Light/Preview/Manual state readback. The original owned
uninstall then completes. Only the fixed continuation preimage leaf receives the
existing bounded large-payload treatment; no arbitrary file limit is widened.

The installed worker now obtains original retained V0/V1 compiler custody and
fresh current V2 compiler custody, claims the already derived continuation,
runs the fixed Windows capture and records the existing positive settlement.
No new journal, publication rendezvous, native Check identity or active-candidate
permission is introduced. The normal helper has no typed failure-cause output;
these observations establish only pre-native refusal plus independently checked
current public Tough/V2 lineage and later V2 behavior, not a claimed native error
subtype. Actual execution/acceptance remains unobserved, and the separate-account
setup/protected proof grant remains unapplied.

Focused connected validation passed 69 tests with zero skips, including actual
PowerShell continuation-guard evaluation against inert files/registration
objects, native helper compilation, worker import routing, fixed phase/config,
private-import refusal and indexed-inventory fixtures. Fourteen changed
TypeScript modules passed typed lint. An initial continuation helper call passed
an obsolete second navigation argument; typed validation identified it and the
caller now uses the maintained one-argument API. No candidate GUI/account logon,
credential access, account/ACL/task provisioning, network proof or protected
publication occurred. The earlier Windows-continuation HOLD descriptions above
record earlier checkpoints; this section describes the connected source only.
