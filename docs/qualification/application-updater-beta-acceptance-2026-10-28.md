# Initial Public beta application updater evidence — October 28, 2026

Owners: [Windows #224](https://github.com/boburning/portcove/issues/224),
[ordinary Linux #225](https://github.com/boburning/portcove/issues/225), and
[integration #52](https://github.com/boburning/portcove/issues/52). This dated
inspection is evidence, not a second backlog or a release authorization. Issues
own acceptance; the live Project owns planning. All three owners remain open.

Initial source inspected: `cee99ee2506f73958b81eb5fe5f36b46e2fcf4ed`.
The [custom authenticated updater](../UPDATER-TRUST.md) already implements the
shared trust, selection, staging and replacement journey. Plugin configuration
absence does not invalidate that implementation. Existing release infrastructure
remains the execution route.

The [October 29 busy-session receipt](installed-updater-busy-observation-2026-10-29.md) adds a successful Windows real-Core refusal/cancellation/fresh-restart chain and Linux space/Unicode/noexec lifecycle observations. The earlier Linux renderer-return failure and old Windows copied-install guidance failure remain explicit. Current Linux head38 run40934887557/1 passes busy refusal, public cancellation/child settlement, fresh explicit Restart, helper/replacement/relaunch and real-data preservation; current-package Windows guidance now passes with painted text, retained ordinary child OS0 and no forced cleanup. Earlier failures remain retained.

## Additional native observations collected on October 28

The [Linux rootless receipt](linux-updater-rootless-observation-2026-10-28.md)
adds an actual Ubuntu 24.04 adjacent run with application UID/GID/stable owner
1001, exact signed package/root/feed identities, full-disk/read-only/locking and
interruption/recovery observations. Its separate default-feature AppImage
startup is not a default-feature updater journey.

The [Linux rootless skipped receipt](linux-updater-rootless-skipped-observation-2026-10-28.md)
adds actual run `40753693767/1`: signed Preview 0.1.0 → 0.3.0, UID/GID/owner
1001 on Ubuntu 24.04.5, exact qualified package/signature/Root/feed identities,
relaunch, contention and failure/recovery controls. Both update endpoints are
qualification builds. Its preserved library/game/save/backup/log files are
synthetic markers; it does not prove existing player data or preferences.

The [Linux historical bootstrap receipt](linux-updater-historical-bootstrap-observation-2026-10-28.md)
adds actual run `40810286569/1`: published Alpha2 with its matching CLI,
settled empty-library UI and exact saved-library Settings readback, normal close,
manual same-path updater-enabled replacement, fresh Stable no-candidate waiting,
explicit Preview opt-in and authenticated 0.3.0 return. UID/GID/stable owner is
1001; the historical application records CapEff 0. All six snapshots retain the
same real 190-byte library-choice preference and original 48-byte marker.
Updater-enabled endpoints remain qualification builds; no game/save or
credential continuity is inferred.

The [Windows local receipt](windows-updater-nonelevated-observation-2026-10-28.md)
adds three controlled adjacent/skipped/Preview-to-final NSIS journeys and
unchanged-pair helper OS-exit replays. The caller is non-elevated, medium
integrity; Administrators is deny-only in a supplementary token observation.
This is not true standard-account or clean-VM proof. Both endpoint builds retain
qualification instrumentation. Exact source overlays, signed bytes, all metadata
signatures, private-input absence, original failures and preservation limits are
recorded separately from the historical receipts below.

The [Windows historical bootstrap receipt](windows-updater-historical-bootstrap-observation-2026-10-28.md)
adds one continuous genuine Alpha2 install/start/close → manual registered
0.1.0 replacement → authenticated 0.3.0 skipped upgrade. It records an actual
Stable no-candidate result before explicit Preview staging, same HKCU/library
and sentinel, helper OS exit 0, relaunch, damaged-stage repair and uninstall.
The updater-enabled endpoints are qualification builds. Historical Alpha2's
private WebView browser-data child was positively observed; general preferences
were absent, and existing games/saves/credentials were not present or qualified.

The [Linux game-data receipt](linux-updater-game-data-observation-2026-10-29.md)
adds actual run `40817075961/1`, source `5371e410`: normal Core installation of
OpenTyrian, three checksum-valid game-authored save/configuration files and exact
installed-record/policy/runtime equality across the signed 0.1.0 → 0.3.0 return.
All 115 runtime entries and player-file hashes, UID/GID 1001 and modes remain
unchanged. Gameplay/loading stays not_evaluated. Separate lifecycle failures,
desktop-entry and uninstall controls retain their different installation and
synthetic-data scope; this dataset does not supply those observations.

The [Windows game-data receipt](windows-updater-game-data-observation-2026-10-29.md)
adds a fresh non-elevated installed run at controller `3850e598`: normal Core
OpenTyrian installation, 117 unchanged runtime entries, three game-authored
save/config files and the same 174-byte saved library choice across rejection,
repair, Stable waiting, explicit Preview signed skipped upgrade, relaunch and
uninstall. Product bytes remain the existing qualified ADC pair; package and
controller sources are distinct.

At that earlier checkpoint, these observations established the separately
described Windows/Linux installed game-data, saved-library choice and marker
continuity. General preferences/credentials, actual reboot, remaining owned
channel/transport/host observations and production publication were then unproven. Subsequent native receipts below fill the specifically owned
cells; general continuity and actual production joins retain their separate scope.
The earlier receipt identities and credited environments remain unchanged.

## Installed failure and retry observed on October 29

The [installed feed failure/retry receipt](installed-updater-feed-retry-observation-2026-10-29.md)
adds ordinary medium/non-elevated Windows and rootless UID 1001 Linux journeys.
Both show the canonical Network error without a false Current claim or new
stage/apply intent, restore the original timestamp identity/bytes, require a
fresh explicit retry, and preserve the original real Core/game-authored dataset
through the subsequent signed skipped update. Windows additionally observes
retained-handle helper OS exit 0, repair and uninstall preservation in that same
chain. Linux's separate synthetic lifecycle fault cases retain their separate
scope. The machine receipt records exact source/package/signature/metadata/feed
identities and the retained failed attempts; no production authority is inferred.

## Receipt inspection and identities

On October 28 both original provider archives below were downloaded, boundedly
extracted as inert data and rehashed. Their digests and the original report
digests match the [previous retained observation](slice4-hosted-observations-2026-10-22.md#actual-hosted-prerequisite-results).
No application or installer in those archives was executed. The archives contain
reports, not the original package/signature/feed bytes. Receipt claims below
therefore remain historical installed observations, not fresh signature checks.
The [identity and preservation snapshot](application-updater-beta-receipts-2026-10-28.json)
records exact available identities and explicitly unavailable fields.

| Identity                             | Windows installed Preview-to-final                                                                                                      | Linux installed Preview-to-final                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Run / attempt                        | [39869759804 / 1](https://github.com/boburning/portcove/actions/runs/39869759804)                                                       | [39857300449 / 1](https://github.com/boburning/portcove/actions/runs/39857300449)                                                       |
| Artifact / archive bytes             | `12469746656` / 7,452                                                                                                                   | `12465479029` / 135,422                                                                                                                 |
| Archive SHA-256                      | `8ba3c96434d6b3ad05b5ff691cab8d23da1fa34651f72e102fcd9f217fdb35b1`                                                                      | `19071ab19fd5f9f1ac918318cddbb59d08d5177a505fd19247a258e291d7b77b`                                                                      |
| Executed source                      | `d21b70316e5add275b5468e54307b536f7126045`                                                                                              | `2c595e2ee6711fef7893bbfa6515c8dbd979f68c`                                                                                              |
| Executed tree                        | `1c8c9bf215b74fb7293e170852ec39e7d2bc0edb`                                                                                              | `d31ec6fa5032b11a773341b405eb1798128bfcb4`                                                                                              |
| Host                                 | Windows Server 2022 build 20348 x86-64                                                                                                  | Ubuntu 24.04.5 x86-64                                                                                                                   |
| Application account                  | Administrator token; integrity SID `S-1-16-12288`                                                                                       | Current-user ownership recorded; numeric UID/GID absent from this report                                                                |
| Transition                           | Controlled `1.0.0-rc.2` → `1.0.0`                                                                                                       | Controlled `1.0.0-rc.2` → `1.0.0`                                                                                                       |
| Predecessor package SHA-256          | `645056bcac373e68f902c0f44686f22742ff4285781aa787313d0973ce67c4c7`                                                                      | `dd33c424f7238aea36d8cc7878035319d167022a32868e6b00cd81a1da666c49`                                                                      |
| Candidate package SHA-256            | `8e7e3e59bbe468cfd9439b09be2dbd135086fd9fe58da34637cbd079f99f34f2`                                                                      | `3c38d83113d0c6321e398d5b542be51d916407c13cfc6717ca84b1d4b779bad2`                                                                      |
| Verified staged candidate bytes      | 12,075,649                                                                                                                              | 95,279,608                                                                                                                              |
| Predecessor byte length              | Unavailable in downloaded receipt                                                                                                       | Unavailable in downloaded receipt                                                                                                       |
| Payload / metadata / feed identities | Disposable authenticated fixture observation; original signatures, root/role bytes, exact feed digest unavailable in downloaded archive | Disposable authenticated fixture observation; original signatures, root/role bytes, exact feed digest unavailable in downloaded archive |
| OS publisher signature               | Authenticode `NotSigned`                                                                                                                | No OS publisher signature established                                                                                                   |
| Installed candidate                  | Executable SHA-256 `17a2a0b0502bf2c98adbd2422696d131a8fbd0d38d57fae0fe337b6e68b5e056`; one HKCU registration                            | Stable AppImage matches candidate hash; executable mode preserved                                                                       |

Payload authentication, metadata authentication, package hashes, OS publisher
identity and production publication are separate claims. The Windows renderer
JSON/screenshots were omitted from that historical artifact: the outer harness
records their completed assertions, but the original renderer bytes cannot be
independently inspected here. The Linux renderer report is present, SHA-256
`dc9b98f2239e30e32791bace56ee6bdab813649b25f75b758938e287160baf5b`.
No visual claim is made from its uninspected screenshot.

## Proven versus missing acceptance

The final [isolated reboot/recovery receipt](installed-updater-reboot-observation-2026-10-29.md) completes the missing ordinary Linux native cell. Windows and ordinary Linux native platform acceptance are complete at their linked qualification identities. Production/default-feature candidate/Root/feed/signing/publication joins remain unmet under #534 and required by #52; native completion does not complete initial Public beta.

“Credited” means only the exact historical scope stated. A remaining row is not
silently satisfied by current source, a closed component or a fixture version.

| Owner / row                                    | Already proven at stated scope                                                                                                                                                                                                                                                                                                                                                                                                                                                | Missing observation or prerequisite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #224 ordinary current-user installation        | Historical #1752 default-feature install/smoke/uninstall receipt remains credited at its scope. New local qualified updater journeys are separately linked above.                                                                                                                                                                                                                                                                                                             | Real default-feature production source/package/Root/feed joins remain held by #534. Windows real Core busy refusal/cancellation/fresh restart is observed; current-product-source NSIS-derived copied guidance and ordinary close now pass at controller276; unsigned guidance-only package remains separate from signed update journeys; no additional pure-standard-account or clean-VM class is required.                                                                                                                                                                                                                                                                                                                                                                                                   |
| #224 adjacent / skipped                        | Historical signed fixtures remain credited. Local qualification-instrumented 0.1→0.2 and 0.1→0.3 journeys execute without effective administrator rights; unchanged-pair replays measure helper OS exit 0.                                                                                                                                                                                                                                                                    | Existing ordinary adjacent/skipped receipts and the new failure/retry-plus-real-data skipped chain retain their exact package/source scopes. Genuine production candidate/feed publication remains #534.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| #224 Preview / final / Stable waiting          | Historical elevated Server2022 and non-elevated controlled Preview→final receipts retain scope. New historical bootstrap chain observes fresh Stable no-candidate/no-byte-change → explicit Preview skipped update and held-handle helper OS0.                                                                                                                                                                                                                                | Accepted shared channel/promotion/withdrawal/downgrade policy receipts retain their scope; fresh ordinary Stable waiting and explicit Preview consent are observed. Actual signed public publication remains #534, later full 1.0 qualification #46.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| #224 repair / uninstall                        | Non-elevated installed truncated/tampered-stage refusal/recovery, responsive qualified candidate and uninstall process exits. Recursive equality is uninstall-only; the new game-data run additionally preserves a real saved library choice and installed player files.                                                                                                                                                                                                      | The new original real-data chain includes truncated/tampered refusal, repair, helper/relaunch and uninstall. Actual copied old f5 status is unavailable with complete empty known registration scopes; current source38 copied-package guidance is painted at controller276, with unchanged unavailable status and ordinary close OS0; prior failed controls remain retained; no full machine-wide updater qualification is added.                                                                                                                                                                                                                                                                                                                                                                             |
| #225 adjacent / skipped                        | Earlier Ubuntu 22/24 receipts retain their exact scope. Fresh Ubuntu 24 adjacent source `75d762a0` and skipped source `ea4ad388` record UID/GID/owner 1001 and exact signed pairs. The linked historical chain adds manual bootstrap and another signed skipped return.                                                                                                                                                                                                       | Ordinary UID 1001 adjacent/skipped qualification remains credited, now including real-data installed failure/retry. Genuine production candidate/feed joins remain #534. The minimum is updated Ubuntu 24.04+ with loaded WebKitGTK 2.52.6+; no older-distro sweep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #225 Preview / final / waiting                 | Earlier Preview-to-final receipt retains scope. [Historical run 40810286569](linux-updater-historical-bootstrap-observation-2026-10-28.md) adds fresh ordinary Stable no-candidate/no-current/no-stage state with unchanged AppImage, then explicit Preview opt-in and signed skipped upgrade.                                                                                                                                                                                | Accepted shared selection/channel controls retain their scope; fresh installed Stable waiting, canonical failure and explicit retry/Preview return are observed. Controlled versions are not signed public releases; publication remains #534.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #225 locking / capacity / replacement recovery | Installed owner-write refusal, peer lock, actual read-only and bounded tmpfs ENOSPC, pre/post-exchange interruption, displayless repair and backup/reconciliation. The independently reviewed isolated Ubuntu26.04.1 UID/GID1001 reboot/recovery [40993092728/1](https://github.com/boburning/portcove/actions/runs/40993092728) passes, with new boot ID, same machine/caller/host identity, retryable recovery and exact original/candidate/pref/synthetic-witness checks.  | Native reboot/interrupted-copy recovery is now observed; the earlier failed guest and its explicit ordering-cycle skip are retained. Other kernel noexec/capacity/Unicode/peer and owner-layer interruption receipts keep their exact scopes. Synthetic reboot witnesses do not replace earlier real-game data proof; no power-loss/GUI-after-reboot/Deck claim. Actual production/default-feature source/Root/feed joins remain #534.                                                                                                                                                                                                                                                                                                                                                                         |
| #225 offline / redirects / invalid feeds       | [Consolidated receipt](https://github.com/boburning/portcove/issues/225#issuecomment-6091405106) credits owner/consumer signature, replay, expiry, withdrawal, loopback transport and recovery controls.                                                                                                                                                                                                                                                                      | Existing unchanged HTTP consumer receipts #810/#847/#848/#862 (including redirect/drop/truncation/403/429), offline policy #796 and signature/replay/expiry negatives retain their accepted scope. The new ordinary local-file outage/retry adds truthful installed UI behavior. Actual public TLS/feed joins remain #534; no blanket fresh-GUI-negative matrix is added.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Both manual bootstrap                          | Windows: published Alpha2→manual qualified 0.1.0 in the same HKCU/destination/library→signed 0.3.0. Linux: published Alpha2 settled UI/saved choice→manual same AppImage path→fresh Stable waiting→explicit Preview signed 0.3.0. Original markers are never reseeded.                                                                                                                                                                                                        | Historical updater-less manual bootstrap remains credited at its actual source/package scope. Default-feature production source/candidate/Root/feed joins remain #534; independent installations are not promoted into one continuous chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Both preservation                              | Windows: [fresh native game-data run](windows-updater-game-data-observation-2026-10-29.md) preserves the normal installed record/policy, 117 runtime entries, three game-authored player files and saved library choice through repair/update/relaunch/uninstall. Linux: [run 40817075961](linux-updater-game-data-observation-2026-10-29.md) preserves its real installed record/policy, 115 runtime entries, three player files and saved choice through the signed update. | Real installed record/policy/runtime, three game-authored files and saved library choice are observed. Separate Linux lifecycle faults/uninstall remain synthetic. General settings/credentials, raw database preimages and gameplay remain excluded claims, not extra beta gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| #52 ownership / consent / busy / status        | Existing shared contracts plus actual qualified Settings Preview/Manual check/download/Restart journeys; new exact package/root/signature/source joins and Windows held-handle helper OS outcomes. [Installed failure/retry on both platforms](installed-updater-feed-retry-observation-2026-10-29.md) preserves exact files and real data; Windows helper has a retained OS outcome.                                                                                         | Windows real Core busy refusal/settlement/fresh restart is complete at its exact package scope. Current Linux run40934887557/1 passes refusal, public cancellation/child settlement, fresh renderer Restart, replacement/relaunch and original real-data preservation. The older missing-marker failure remains causally unresolved. Current-package copied-install guidance is painted with ordinary child close OS0 and cleanup forced=false; previous source38 harness failure is retained. Truthful waiting/failure/retry, explicit check/download/Restart, real data and exact qualification package/feed/signature joins are now observed. Genuine production joins remain #534. Actual isolated Linux reboot/recovery also passes at controller7e93; production remains a separate unmet #534/#52 gate. |
| #52 production integration                     | Shared custom authenticated release infrastructure and isolated signing/feed design                                                                                                                                                                                                                                                                                                                                                                                           | #534 actual provisioned signing/feed/production authority and exact candidate joins. No signed public publication is claimed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The older Windows adjacent receipt has a 10,504,537-byte candidate SHA-256
`6c04fe842f501300c50ba631a5b7591a682acfecbef7449e1203e8381d6fdc6b`
and replacement executable
`c9f1bfcb56edb5f2f20893bda874f2a7b2324840f9d8eca3de76d04507b54539`.
The Linux adjacent predecessor/candidate hashes are
`5ff0d64d216c67140be7ba677ecab042ba86bde5feda02e046d31f82db1e3acf` /
`dec7a2583d7d911b4a0377da8b1ac01cfdc5ec1f68f9a9edaae6942395cec0c6`,
with 93,006,328 staged bytes. These identities are credited from their linked
receipts; their original packages/signatures were not reverified in this pass.

## Current execution boundary and independent repair

Initial read-only host preflight observed Windows 11 Home build 26300 with a
non-elevated current token, no Portcove HKCU/HKLM registration at the fixed
paths and no named Portcove process. This does not prove a clean VM, absence of
unregistered copies, native admission, current signed cohort or preserved-data
isolation. The local WSL kernel is `6.18.33.2-microsoft-standard-WSL2`;
`sudo -n true` refused because interactive authentication is required. No mount,
account, credential, privilege or protected setup was changed. The full Linux
capacity fixture requires its existing separately privileged tmpfs setup; that
setup is distinct from ordinary application execution.

Independent non-writing source review found that matching file/caller UID alone
allowed UID 0 to pass the AppImage harness's rootless claim. The harness now
rejects root and unavailable/failed identity queries before resolving inputs or
creating state, and records actual caller UID/GID and stable-file owner UID.
Additive fields retain schema 15 compatibility. Controlled executable preflight
tests are harness evidence only; they do not complete installed platform rows.

Resume missing native rows with the existing admitted installer/AppImage route,
fresh disposable signed cohort where appropriate, exact historical bootstrap
inputs, isolated real data, observed host/account and positive owned-process
settlement. Preserve the original package/signature/root/delegation/feed bytes
and their hashes before cleanup. Source changes require their applicable review
and exact-head CI; historical successful receipts retain their original source.
Production execution additionally requires #534's real authority. Missing
production authority does not block independent rehearsal/fix delivery.

## Separate Linux release decision

[#706](https://github.com/boburning/portcove/issues/706) and
[#49](https://github.com/boburning/portcove/issues/49) remain open for remediation.
The existing GLib 0.18.5 ordinary x86-64/default Desktop plus
`tauri/custom-protocol` risk disposition is scoped and non-remediating. It expires
November 14, 2026 at 23:59 America/New_York
(`2026-11-15T04:59:00Z`), or before the second ordinary Linux Public beta
publication following approval, whichever comes first. The first publication
tag must be bound at actual candidate reconfirmation; it cannot be reallocated
to reset the budget. No automatic renewal or release eligibility follows from
this receipt inspection. Reconfirm exact candidate/native inputs, full scanner
result, publication count and current policy at actual release time.

Later full 1.0 package qualification remains #46. macOS #226 and Steam Deck
#535 are independent owners; ordinary Linux does not qualify Deck. None of those
later outcomes is added as a blocker to this initial Windows/Linux beta scope.
