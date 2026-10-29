# Installed updater feed failure and retry — October 29, 2026

Owners: [#224](https://github.com/boburning/portcove/issues/224),
[#225](https://github.com/boburning/portcove/issues/225), and
[#52](https://github.com/boburning/portcove/issues/52). All remain open.

Ordinary installed Windows NSIS and Linux AppImage journeys now show a truthful
feed failure, restoration of the original feed file, and a fresh explicit retry.
Both continue into an authenticated skipped Preview update with their original
normal Core game installation and game-authored save/configuration files.
The [machine-readable receipt](installed-updater-feed-retry-observation-2026-10-29.json)
records exact packages, payload signatures, public keys, signed metadata/records,
source composition, account privileges, process observations and preservation.
These are disposable local-feed qualification builds; production authority is
still held by [#534](https://github.com/boburning/portcove/issues/534).

The real failure exposed a presentation bug: the shared operation runner settled
its error record but swallowed the rejection, allowing the Settings panel to
continue as though its request returned. Application-update actions now opt into
propagating the original failure after settlement. Existing invocation conflict,
stale-generation, cancellation and default caller behavior stay explicit. The
panel uses Core's canonical error presentation. A second harness bug attempted
to save an unchanged Stable/Manual choice twice; the driver now observes the
actual saved choice and enabled Check action before proceeding. An arbitrary
disabled Save button does not establish the postcondition.

## Windows

The non-elevated caller has medium integrity and Administrators deny-only;
`administrator_token` is false. The observed host is Windows build 26300 x64,
with WebView2 runtime inventory `156.0.4314.50`. This is ordinary non-effective-
administrator proof. A pure standard account or clean VM is not an added gate.

Controller `489450951a2545ae87edcc74cdc15b95f65f0250` runs freshly built product
bytes from `f5f4917654819db99c2f9a9cc0f671623cf8c55f`. The qualified 0.1.0 NSIS
is 14,747,211 bytes, SHA-256 `04b0e4ca…`; the 0.3.0 candidate is 14,081,474
bytes, `49021f80…`. Both exact payload signatures passed the maintained verifier.
The complete 17-file binding includes package/signature bytes, encoded and
decoded public-key identities, Root, all metadata, signed records and candidate
PE. No equivalence between the f5 product and later controller source is claimed.

The ordinary UI first observes Stable waiting. With only the owned timestamp
withheld, it displays “The online request could not be completed.” It creates no
stage, apply intent or recovery requirement, preserves the saved choice and
installed PE hash, and makes no Current claim. Restoration retains the original
file identity and 622 bytes (`62815b5b…`), and seals late fault writers. A fresh
explicit Check returns to Stable waiting. The same session then explicitly
selects Preview/Manual, checks, downloads, verifies and restarts into 0.3.0.

Helper PID 9600 has retained-handle OS exit 0 and its matching outcome marker.
The candidate relaunch is observed with the expected PE `3c182cf7…`; candidate
disappearance is not promoted to OS exit 0. The later candidate smoke and
uninstall parent/self-copy separately have observed OS exit 0. Truncated and
tampered stage refusal, damaged-stage repair, and uninstall all use the same
original dataset. The final observer matches the installed record/policy, all
117 runtime entries (16,275,349 file bytes), three game-authored files and the
174-byte library preference (`4077ce38…`). Recursive database/library equality
is an uninstall observation only. The screenshot paints Library 1 and verified
Preview 0.3.0 with an interface-size warning; clean scale/UI qualification is
not claimed.

The public-input capsule contains 49 explicitly named files, 1,009,284 expanded
bytes, and is 298,740 compressed bytes with SHA-256 `dfc4e6ef…`. Signed feed
inputs are copied byte-for-byte. Native account reports are privacy projections
linked to original hashes. Profiles, credential stores, database/runtime/package
bytes and private signing inputs are excluded. Private paths do not isolate the
fixed Windows Core credential store; no anonymous or credential-continuity
claim follows.

## Linux

[Run 40864767451/1](https://github.com/boburning/portcove/actions/runs/40864767451),
job `123416627197`, executes source `48945095…` on Ubuntu 24.04.5 x64. Caller UID/GID is 1001; the historical application records CapEff 0. Stable-file
ownership remains UID 1001 and mode 755.
Loaded WebKitGTK/JavaScriptCore/GLib paths and hashes are recorded separately
from the prerequisite provisioning log for WebKitGTK 2.52.6.

The exact qualified 0.1.0 AppImage is 98,867,704 bytes (`fee52535…`); candidate
0.3.0 is 98,609,656 bytes (`7a1e13f4…`). Their 440-byte signatures, encoded
152-byte public key, decoded key identity, Root, seven positive metadata
envelopes and three signed records remain joined to the complete artifact.
Independent payload verification uses the existing maintained verifier; neither
AppImage is executed during that readback.

The same installed renderer observes the canonical Network alert, unchanged
Stable/Manual choice and executable, no stage/apply/recovery, original timestamp
restoration, fresh explicit retry and subsequent signed Preview return. All nine
historical snapshots retain the 190-byte preference (`7fae6702…`), 48-byte marker
(`9656224e…`), owner/mode and private bus. The normal Core dataset matches before
and after: 115 runtime entries, 16,038,035 file bytes, installed record/policy
and the three game-authored files. Separate read-only/full-state/full-filesystem,
peer-lock, process-interruption, journal, displayless repair and synthetic
uninstall observations retain their separate installation/data scope.

The renderer records helper/candidate termination and an empty owned inventory;
these are not independent OS exit 0 observations. The historical window PNG
still shows loading. Later DOM evidence, painted saved-root Settings, normal
close and the painted before-restart Library 1/verified candidate are separate
positive observations; no settled historical paint claim comes from that PNG.

Artifact `12894853631` is 629,186,147 bytes, SHA-256 `799dc033…`. Raw bounded
ZIP preflight preceded parser construction; all 517 members (839,816,673 expanded
bytes) passed size, CRC and SHA checks with an immutable input file. Selected
reports and public inputs were read inertly with their original member hashes.

## Retained failures and remaining boundary

The earlier generic-error/old-oracle failure, Linux duplicate-Save failure,
Windows pre-effect JSON date guard failure, and 20-second Windows initial
process-reader timeout remain failed evidence. The timeout case was positively
uninstalled with preserved game data. The unchanged reader later observed an
owned Node-plus-console-host tree in 1.35 seconds and Node EOF OS exit 0; one
fresh installed case then passed. The original timeout cause remains unknown.
Two failed evidence projections remain private: incorrect failure-report paths,
then reserialized trust JSON. The final capsule retains exact trust bytes.

Real Core busy-session restart refusal/settlement/retry remains unfinished.
Original-file/system-wide/unregistered-copy guidance still needs scoped
reconciliation. Actual Linux OS reboot is unobserved; no demonstrated isolated
reboot route or permission to reboot the shared host exists. Actual production
candidate/default-feature source/Root/key/grant/feed/signing/custody/publication
and readback remain #534. Existing HTTP/policy negatives retain their accepted
consumer scope; this local-file fault does not claim a real HTTP/TLS outage.

General settings/credentials, gameplay and raw database preimages remain excluded
claims rather than new beta gates. Full 1.0 #46, macOS #226 and Steam Deck #535
remain independent. The separate #706/#49 scoped, non-remediating GLib disposition
still expires November 14, 2026 at 23:59 America/New_York, or its earlier relevant
second-beta trigger. Reconfirm the exact candidate, complete scanner result,
publication count and current policy at actual release; no renewal is presumed.
