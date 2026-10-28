# Initial Public beta application updater evidence — October 28, 2026

Owners: [Windows #224](https://github.com/boburning/portcove/issues/224),
[ordinary Linux #225](https://github.com/boburning/portcove/issues/225), and
[integration #52](https://github.com/boburning/portcove/issues/52). This dated
inspection is evidence, not a second backlog or a release authorization. Issues
own acceptance; the live Project owns planning. All three owners remain open.

Source inspected: `cee99ee2506f73958b81eb5fe5f36b46e2fcf4ed`.
The [custom authenticated updater](../UPDATER-TRUST.md) already implements the
shared trust, selection, staging and replacement journey. Plugin configuration
absence does not invalidate that implementation. Existing release infrastructure
remains the execution route.

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

“Credited” means only the exact historical scope stated. A remaining row is not
silently satisfied by current source, a closed component or a fixture version.

| Owner / row                                    | Already proven at stated scope                                                                                                                                                                                                                                                                          | Missing observation or prerequisite                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #224 ordinary current-user installation        | [#1752 receipt](https://github.com/boburning/portcove/issues/224#issuecomment-6104094335): nonadministrator Windows 11 Home build 26300, default-feature NSIS `0.1.0-alpha.2`, install/smoke/normal close/uninstall, positive captured process exits                                                    | Actual ordinary-user updater transition; this was a current-installed smoke, not an upgrade                                                                                                                         |
| #224 adjacent / skipped                        | [#1362](https://github.com/boburning/portcove/issues/224#issuecomment-5938364644), #1278 and [#1492](https://github.com/boburning/portcove/issues/224#issuecomment-5981813764): authenticated installed fixture transitions and rejection/recovery                                                      | Fresh signed adjacent/skipped cohort executed as an ordinary non-admin user on the required environment; exact helper outcome where previously unobserved                                                           |
| #224 Preview / final / Stable waiting          | Rehashed Server 2022 Preview-to-final receipt above; deterministic channel selection                                                                                                                                                                                                                    | Ordinary-user relevant channel transitions and actual waiting/no-downgrade behavior; real public-beta-to-1.0 production qualification remains #46                                                                   |
| #224 repair / uninstall                        | Installed truncated/tampered-stage refusal, GUI-independent repair, responsive candidate and unchanged recursive library/preferences uninstall manifests                                                                                                                                                | Missing ordinary-user recovery/failure rows, actual prompts/passive/system-wide guidance, interruption/reboot and real installed game/save scope                                                                    |
| #225 adjacent / skipped                        | [Adjacent 37149016052/1](https://github.com/boburning/portcove/issues/225#issuecomment-5973192178): Ubuntu 22.04.5, glibc 2.35, WebKitGTK 2.50.4, FUSE 2.9.9; [#1256/#1267](https://github.com/boburning/portcove/issues/225#issuecomment-5886280398): Ubuntu 22/24 skipped installed renderer journeys | Historical/manual bootstrap and remaining exact ordinary minimum/environment rows; freshly identify caller privileges on future runs                                                                                |
| #225 Preview / final / waiting                 | Rehashed Ubuntu 24.04.5 installed Preview-to-final receipt; signed selection fixtures include waiting                                                                                                                                                                                                   | Actual applicable Stable-waiting UI/installed state without downgrade; controlled versions are not a historical published transition                                                                                |
| #225 locking / capacity / replacement recovery | Installed owner-write refusal, peer lock, actual read-only and bounded tmpfs ENOSPC, pre/post-exchange interruption, displayless repair and backup/reconciliation                                                                                                                                       | Real OS reboot observation; missing mount/noexec and path/environment claims at declared scope. Exit-86 instrumentation is interruption evidence, not reboot                                                        |
| #225 offline / redirects / invalid feeds       | [Consolidated receipt](https://github.com/boburning/portcove/issues/225#issuecomment-6091405106) credits owner/consumer signature, replay, expiry, withdrawal, loopback transport and recovery controls                                                                                                 | Missing actual remote/offline/redirect/rate-limit rows at required installed scope; local file/loopback transport is not public TLS/feed publication                                                                |
| Both manual bootstrap                          | Existing documented manual upgrade route and package ownership rules                                                                                                                                                                                                                                    | Actual updater-less historical package → updater-enabled installation followed by authenticated updates. Rebuilding `0.1.0` from current source cannot establish this                                               |
| Both preservation                              | Windows recursive library DB/artwork/preferences; Linux exact synthetic library/game/save/backup/log markers and desktop entry, retained in snapshot                                                                                                                                                    | Real installed library/original game/save/configuration boundary still missing. Synthetic filenames are not actual saves; no rollback may restore stale player state                                                |
| #52 ownership / consent / busy / status        | Shared component contracts and deterministic checks; actual Settings Preview/Manual check/download/Restart journeys                                                                                                                                                                                     | Consolidate both ordinary platform journeys with exact original-file ownership, busy-session behavior, explicit consent and recovery evidence. No isolated library implies credential/WebView/lease-store isolation |
| #52 production integration                     | Shared custom authenticated release infrastructure and isolated signing/feed design                                                                                                                                                                                                                     | #534 actual provisioned signing/feed/production authority and exact candidate joins. No signed public publication is claimed                                                                                        |

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

Read-only host preflight observed Windows 11 Home build 26300 with a
nonadministrator current token, no Portcove HKCU/HKLM registration at the fixed
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
