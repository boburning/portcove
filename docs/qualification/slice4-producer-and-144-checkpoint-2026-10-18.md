# Slice 4 producer integration and #144 native checkpoint

Owners: [#534](https://github.com/boburning/portcove/issues/534),
[#144](https://github.com/boburning/portcove/issues/144), and
[#246](https://github.com/boburning/portcove/issues/246). Starts at merged #2125,
`dbf8f979b90ca4513d46dca7ff766fea12d1f2d3`. D1/D2/D3 remain selected.
The [canonical authorization packet](slice4-production-authorization-packet-2026-10-18.md)
continues to own decisions. This is implementation and qualification evidence,
not an execution, publisher, credential or custody grant.

## Actual producer and exact integration blocker

The existing review process is an owner-run Codex independent non-writing local
task. Owner actor: `43177418`; retained task: `/root/reservation_review`. Its
[actual retained report and inputs](slice4-existing-review-scope-2026-10-18.json)
review implementation #2125 at `8bdeebd5c62129695c082decf514049adc7a8f71`
against `c6470ec28ba9addb0f70d9f86953322d835bb8c0`, including the later
packet-only repair. That clearance does **not** review a complete accumulated
release opportunity, classification and compatibility. It is not semantic
release acceptance.

Complete paginated readback for PRs #2124/#2125 found zero submitted GitHub PR
reviews or inline review comments. The 30 checks on #2125's reviewed head have
only issuer GitHub Actions App `15368`. Repository workflows have no independent
semantic-review job. These observations cover those exact PRs/head, not every
installed App. Available task/private-review and PR-review transports do not
provide a producer-owned whole-opportunity CheckRun handoff. No numeric semantic
issuer or successful semantic check has been established.

**One blocker:** the actual independent runtime has no appointed, isolated,
authenticated completion-to-CheckRun transport. Giving an App a caller-supplied
transcript would not fix it. The proposed remedy is the
[fixed producer boundary](slice4-semantic-producer-transport.proposed.json):
reuse the local independent Codex review process, capture its completed output
directly in a trusted controller, and publish through a distinct producer role
with repository Checks-write / Metadata-read. Classification persistence remains
the already selected separate writer. Generic Actions and the writer remain
excluded as semantic issuers. No alternative classifier, trust journal or
recurring personal artifact stamp is proposed.

Installed `codex-cli 0.162.0` exposes non-interactive stdin, read-only sandbox,
JSON events, output schema and final-message output; this confirms command
capabilities only. No new review was launched or authenticated by those flags.
[Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes structured output. A sandbox flag does not isolate every host file,
credential, plugin or hook; the trusted broker must enforce its separate OS and
credential boundary. The current shared task does not supply that boundary.

The inactive `release-semantic-review.mts` serializer now retains the actual
report, report SHA-256, runtime/session reference, canonical whole-second UTC
completion, explicit full-opportunity coverage and exact accepted opportunity.
The existing consumer requires summary schema 2 and persists classification
schema 2 with a digest of the complete verified provider proof. The old output
title ending `v1` is only the existing envelope label, not a v1 report allowance.
Legacy reports/records fail closed; there is no automatic overwrite or migration.
There are no deployed records to migrate. Historical coordinator schema-1 replay
is unaffected. A serializer's shape checks cannot prove that its statements are
true or that an independent runtime authored them.

Focused contracts exercise exact serialization/consumption, changed opportunity,
wrong issuer, writer/Actions exclusions, PR-only scope, omitted coverage,
changed report bytes, changed persisted proof, legacy refusal and no overwrite.
These are fixtures, not an observed producer binding. After the role and isolated
runtime bridge exist, retain one actual complete-opportunity report, observed
App/installation/check identity and exact inputs; run the same consumer and
negative cases against that observed handoff before any protected execution.

The latest public release inventory has two entries. Alpha.2's target is
`27328c8a1b30bf92868bcf3cde313f2720c8fd1e`; it is not a substitute for
independently establishing the last publication baseline, full accumulated
source delta and eligible opportunity. No production opportunity or reservation
is invented from the implementation PR diff.

## #144 real .35 / .36 result

**Not selected as a suitable full-default-persistence pair.** Both real packages
start on the available Windows native host using the authorized owned source,
bundled OpenBIOS and existing StagedSourcePortable/PsxBinCue route. Controlled
forward and rollback state copies preserve the tested bytes and consume the
seeded `720p` setting. However the runtime creates an absolute resource path in
`mods/state.toml`; `.36` retains `.35`'s executable-tree address. Core installs
artifacts in separate roots and has no current catalog-level rebasing mechanism.
Deleting the state or preserving all mod code would conceal this defect.

Exact [native evidence](slice4-144-native-evidence-2026-10-18.json) includes
process identities, report/log hashes, package-file readback and scope limits.
Archive acquisition and embedded-contract evidence from #2125 remains applicable.
The provider repository is `mstan/MegaManX4Recomp`, numeric ID `1290451017`:

| Package                 | Source                                     | Release / asset           | ZIP SHA-256                                                        |
| ----------------------- | ------------------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| v0.1.1-coop-playtest.35 | `26a2d5370ad87ec5b486359d8dda29c9eb09a54a` | `416200615` / `652294330` | `d96ef401c17184b1b9ac15063e0bf533586d8985f8dc205b04ddd11b45bc9c78` |
| v0.1.1-coop-playtest.36 | `a020ad1ecd287b6e73400e526961897c36d5016e` | `416323808` / `652917999` | `4dbcb36cbfc89a32403390a381bb0545b736ccaa98ba8400b7196fa74c3d5133` |

Both upstream submodule records pin `mstan/psxrecomp`
`6af3a69dd35a17b411f3e04e229aba76203fa600`. Both actual runtime reports
identify `nightly-489-g6af3a69d`, with their distinct build dates. This binds
source review and observed build identity; matching downloads and self-reported
build IDs do not establish reproducible-build provenance or protected acceptance.

The owned CHD was available at the previously authorized local source route.
CHDman 0.287 verified raw and overall SHA-1 and normalized it to 592,217,136 bytes,
SHA-1 `26ffe24a79384b24af7571674251ee575e889b38`, SHA-256
`3ceab06ac99add4035f912188bcbf5b16c02056f46a33d38ff0c8dbce6cb613b`.
No additional source or native host request is needed. Proprietary bytes, private
paths, memory cards, caches and raw native diagnostic contents stay outside Git.

### Runtime and persistence contract

Executable `MegaManX4Recomp.exe`, working directory the extracted executable root.
Existing `StagedSourcePortable` / `PsxBinCue` capability version 1 materializes a
directory `disc`; the Core CUE names `disc1.bin`. Controlled probes used equivalent
normalized bytes with a manually prepared `disc.bin` CUE, so they do not claim
Core materialization or an installed lifecycle. Arguments seed
`--disc disc/disc.cue --memcard-dir saves`. The ordinary launcher remains enabled;
`--no-launcher` was an explicit native-probe-only argument. Bundled
`bios/openbios.bin` supplied the observed OpenBIOS LLE backend/HLE shell skip;
no retail BIOS acquisition or generation is required by this tested route.

| State / path                                                                                                    | Intended treatment and observed limitation                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `saves/`, memory cards, options and runtime-created diagnostics                                                 | Preserve actual player/state bytes; both 128-KiB cards exist. Directory also contains diagnostics, so do not describe every file as a game save.                                                                                                                                                 |
| `settings.toml`, `input.ini`, `keybinds.ini`, `config.ini`, `bios.cfg`, `disc.cfg`                              | Preserve existing files. Test-owned settings selected `720p`, which both runtimes consumed. Controller/input and in-game save/load remain unobserved.                                                                                                                                            |
| `mods/state.toml` and interrupted `.tmp`                                                                        | Preserve state/recovery evidence. **Blocked:** generated resource address points into old executable root.                                                                                                                                                                                       |
| `mods/bundled`, bundled assets, `overlay_toolchain`, executables, `game.toml`, version/execution contract, BIOS | Artifact-owned executable/immutable content; never persist the whole `mods` tree. All packaged files matched after probes.                                                                                                                                                                       |
| `mods/installed`, texture-resource packages                                                                     | User-supplied executable/resource content requires a separate explicit contract; not silently player state or disposable cache. No package was installed here.                                                                                                                                   |
| `disc`, JIT `cache`, overlay captures/history, freeze/last-run reports, diagnostic path markers                 | Source materialization or generated/disposable runtime output. Generated cache includes executable DLLs; do not carry it across artifacts as retained user code.                                                                                                                                 |
| `%LOCALAPPDATA%/psxrecomp/imports`                                                                              | Additional framework media cache. Early probes inherited shared host location; it was observed and left untouched. Last two probes redirected LOCALAPPDATA to owned scratch. A proposed relative launch environment needs its own qualification before claiming the ordinary route is contained. |

At the reviewed framework pin, `mod_runtime.cpp:1539-1549` preserves a nonempty
resource path and otherwise generates an absolute default; `mod_packages.cpp:884-895`
uses that string, and `3254-3255` stores it unchanged. The runtime hardcodes the
executable-root mod directory (`psxrecomp_main.cpp:17150-17157`). The actual
retained state contains the `.35/mods/texture-packs/SLUS-00561` absolute path
even with the feature disabled. Both source and native readback substantiate the
default persistence defect; it is not a speculative gameplay concern.

Six native probes closed normally with exit 0 and responding owned windows;
final isolated .36 / rollback .35 reports reached 1181 / 1177 frames without
autocompile degradation. Forward copy retained all 26 files; rollback retained
all 46 files, with no changed retained paths. These are controlled package-copy
component observations, not the #246 protected journey. No useful foreground
render capture was obtained; black PrintWindow captures and a debug-port probe
failure are retained and confer no gameplay acceptance. One resource-supervisor
queued invocation refused after source changed and ran no game. No failure was
discarded or relabelled as successful qualification.

**Next bounded engineering action:** an upstream portable resource-path fix,
then qualify two real artifacts containing that fix. Alternatively a finite,
separately reviewed client migration capability is new engineering scope and
cannot silently satisfy D3's existing-capability selection. A manually configured
relative resource path proves only that narrower configuration. Do not deliver a
definition, freeze a misleading baseline or record initial absence for this pair.
Gen2 entries and identities remain unchanged and supply only their prior scope.

## Capacity provenance and remaining aggregate integration

`readRatifiedCapacityConfiguration` prepares the D2 read through the existing
owner-controlled pause ref `portcove-release-pause`, fixed `capacity.json` path.
It verifies raw Git objects, brackets the exact ref and invokes the caller's
authenticated fresh observer/job guard before and after. Its exact document is
`{schema_version:1,capacity,observation}`; observation names actor `43177418`,
provider-UI spending configuration, time and retained evidence SHA-256. It rejects
operation history injected into configuration. Ratification/revocation uses the
delivered D2 evaluator; availability/headroom remain Unknown, reservation none.
Hashing and an owner-authored document alone do not prove live provider settings.
No document was installed and no observer or credential was activated.

Before a protected attempt, an authorized operator must observe the exact account,
account-wide $0 Actions budget with stop-usage enabled, repository visibility,
standard public runner/resource restrictions and ratified policy generation;
retain that observation and write the selected protected owner configuration.
Invalidate it before changes to any relevant setting. This is configuration
ratification, not a recurring artifact approval or a billing-reader dependency.
Existing spending/resource estimates and held workflow bytes are unchanged.

The delivered local pending-before-effect/recovery machinery remains applicable.
Remote pending publication and exclusive execution are still unassembled:
publish/read back exact candidate, reservation, operation and preimage through
the existing remote coordinator before effects; require the actual fixed
workflow run/job/attempt and existing concurrency ownership. Identical remote CAS
readback is not an exclusive executor lease. Refusal or ambiguity retains phase,
completed effects and evidence; explicit existing readback/recovery is required
before a later bounded attempt. No new journal, retry loop, remote effect or
eligible reservation is asserted here.

The next new owner decision is the **specific semantic producer transport role**
above, once its prepared boundary is reviewed. Approval selects the runtime/broker
and producer issuer authority; it does not create the isolated execution host,
App installation/custody, actual report or provider observations. Those require
provisioning and demonstrated readback. D1 classification writer/observer and D3
catalog separation are already selected and are not mechanism questions again.

Protected execution additionally needs a final runnable controller revision,
workflow digest/full protected ref, actual operator/namespace/permissions and
destinations, custody/public-key evidence, observed protections, eligible
candidate/reservation and an exact grant referring to that candidate. The current
candidate is inactive preparation, not that runnable controller. Assembly and
attestation remain one stage; signing, publication, feed, custody and recovery
remain separate #534 obligations. #254 stays Done; #315/#534/#246 acceptance stays
pending; Chameleon protected acceptance is unset. No slice 5 work was started.
