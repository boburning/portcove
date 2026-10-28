# Marathon official Windows package pins — October 28, 2026

This dated candidate receipt covers three existing frozen identities under #2926
and #2510: #2588 Marathon, #2589 Marathon 2: Durandal and #2591 Marathon Infinity.
They are already inside the 858-identity union and are not historical #1422
members. Three operational definitions are proposed; listing membership is
unchanged. The canonical issues and PR retain final delivery/acceptance status.

| Identity                        | Exact full package                  | Player inside its wrapper       |
| ------------------------------- | ----------------------------------- | ------------------------------- |
| `marathon-aleph-one`            | `Marathon-20260930-Win.zip`         | `Classic Marathon.exe`          |
| `marathon-2-durandal-aleph-one` | `Marathon2-20260930-Win.zip`        | `Classic Marathon 2.exe`        |
| `marathon-infinity-aleph-one`   | `MarathonInfinity-20260930-Win.zip` | `Classic Marathon Infinity.exe` |

The official release includes each game's freely distributed scenario. No
separately supplied commercial original, ROM, setup helper or downstream build is
needed. All three full archives match their publisher SHA-256 and sizes and
contain their own scenario files and a single AMD64 player. Complete and
engine-only packages share the same stable literal hint matches. The existing
Direct manifest therefore pins the full `release-20260930` archive, rather than
assuming an automatic selector can distinguish it. No newer upstream version is
discovered by this definition. A later catalog pin is a separate artifact and
compatibility decision; unknown future compatibility is not accepted now.

The existing native lifecycle gains this exact archive combination, retaining
its source/helper/mutable-runtime exclusions and Direct's Stable/platform/
version/URL/size/hash rules. Installers and bare executables remain ineligible.
NativePortable template version 3 identifies exact archive pins. Version4 additionally consumes the packaged-file Windows path policy, so these three new and retained independent entries require4. Versions1/2/3 retain their earlier meanings. API envelope 82, operation events 3 and definition
capability schema 1 retain their meanings; there are no new transport fields or
commands. Compiled CLI readback accepts Native versions 1/2/3 and reports 4 as
incompatible. Negotiation is separate from admission and operation authority;
existing unsupported scoped Direct acquisition does not become protected
publication or installed Desktop acceptance through this capability.

## Runtime, source and player data

The managed working directory is the exact per-game wrapper in the pinned ZIP.
Literal `.` selects its bundled scenario. In the inspected Windows source,
`ALEPHONE_DATA=';'` is an empty search-root list: the separator-only element is
skipped and no additional root is appended. `ALEPHONE_DEFAULT_DATA='.'` makes the
same directory explicit. These existing fixed arguments/environment values
avoid ambient data/MML/script roots without changing Core's environment guard.
Their meaning is Windows- and source-scoped, not a new cross-platform promise.

Source defines upstream profiles in `Documents/AlephOne` (logs, saves, quick
saves, recordings and screenshots) and `LocalAppData/AlephOne` (preferences).
Explicit Play can read/update an existing shared upstream profile. Core does not
adopt, back up or rewind it. Preserve the creating runtime and actual profiles
before changing runtimes; older-version save/state compatibility is unproved.
Fresh official packages contain no legacy `Prefs`; do not copy old runtime files
into this managed copy. Source can move legacy package-local preferences, so
unexpected additions remain held by the existing strict immutable guard.

The inspected update worker reads version metadata over HTTP in an SDL thread;
it does not download or replace runtime files. Core owns this separate pinned
runtime. Existing external copies retain their own files and update owner.

## Observations and boundaries

An uncontended existing native-session lease covered bounded Windows probes.
Both profile roots were absent before the first run; later runs checked the exact
completed owned profile preimage. The final contract was exercised with a valid
other-scenario ambient root in the probe parent and the exact child overrides.
Each player reported Aleph One 1.11.1, Windows 2026-09-30, completed two timed
startups and normal window-close exits. All nine final processes exited 0, with
no forced termination and positive exit proof before further file observation.
The three package regular-file sets and hashes were unchanged. Observed profile
files were the shared `Aleph One Log.txt` and distinct `Marathon Preferences`,
`Marathon 2 Preferences` and `Marathon Infinity Preferences`.

These are actual Windows process/version/startup/restart/write observations.
Window titles and timed sessions do not establish rendered menu content,
gameplay, save/load, physical input, minimum hardware or backwards compatibility.
A later private Core probe using the exact CI-produced prior candidate CLI completed install/verify/explicit Play/reverify/removal for Marathon and Durandal. Infinity installed and verified but Play failed opening its packaged MML file at long coordinates. Ordinary and Core working-directory controls both failed; a shorter alias to the same physical runtime succeeded. These observations establish a coordinate restriction, not its exact threshold or a general long-path repair. Missing exit-code harness attempts and the failed Infinity launch remain retained. The repaired Native4 normal CLI from exact source140773cd /CI40649083764/a1 then completed all three private Windows Core lifecycles at supported short output paths: plan, install, immutable verification, two explicit startup/normal-close cycles, re-verification and removal. All six game and CLI exits were0, with no forced termination and positive process/operation drain. A negative long-coordinate install returned the typed path refusal without publishing/launching or changing observed upstream profile files. These are process/lifecycle observations, not gameplay, save/load or rendered menu acceptance.
Qualification flags remain empty; no Project Supported promotion is inferred.

Thirty-three native-related Core contracts and 43 authoring/preparation/proposal
contracts passed locally with zero skips. Compiled Core accepted the complete
170-port proposal. Exact-head hosted qualification and final independent review
belong to the PR. Initial generator refusal, old-Core provider refusal, local test
compile errors, empty-environment refusal and pre-execution PowerShell policy
refusal are retained. Earlier default/blank-environment probes retain their
original scope; the final exact-map receipt supplies the observations above.

The companion JSON records source and package identities, per-record hashes,
protocol readback, native receipt hashes, limits and next evidence. No signing,
protected execution, publication, credentials or retained-data authority changes.

## Shared packaged-file path repair

The existing runtime-path authority gains a Native4 policy for a conservative
Windows UTF-16/MAX_PATH envelope, including the terminating NUL and relative
`.\` spelling. It checks every authenticated immutable member, the selected
player and working directory at final coordinates. Fresh/adopted publication,
retained reuse/rollback, pre-sync launch, interrupted publication and portability
apply the same creating contract. It imposes no ASCII-only rule, claims no exact
upstream threshold, and grants no external-profile or future save-path ownership.
A fitting EXE cannot hide a longer scenario data filename. Select a shorter output
folder when held; a short diagnostic alias is not a Core managed-path guarantee.

Earlier oracle-only source bbc0 passed all five contexts in40643429882/a1; Native4
changes invalidate that qualification. The companion JSON preserves its scope and
exact native failure/control hashes. The Native4 Windows Core observations are now retained in the companion JSON.
CI40649083764/a1 failed the stale generated Desktop transport projection; the
Rust-owned schema/type regeneration changes no Core behavior. Final independent
review and fresh exact-head CI still belong to the PR before delivery.
