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
NativePortable template version 3 identifies this new combination; versions 1/2
remain supported with their earlier meanings. Independent new and retained
entries need minimum version 3. API envelope 82, operation events 3 and definition
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
No actual Core-managed Windows installation/Play/removal session is credited in
this source receipt. Existing synthetic lifecycle coverage remains distinct.
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
