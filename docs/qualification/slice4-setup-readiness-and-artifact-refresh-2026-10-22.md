# Slice 4 setup readiness and game-artifact refresh — 2026-10-22

Owner: [#534](https://github.com/boburning/portcove/issues/534); independent artifact work: [#144](https://github.com/boburning/portcove/issues/144) and [#246](https://github.com/boburning/portcove/issues/246). This records actual preparation and one proposed environment amendment. Production remains held.

## Actual account and credential completion

The owner completed the [reviewed recorded-account continuation](slice4-profile-setup-continuation-2026-10-22.md). Independent ordinary-broker composite readback verified both actual registered profiles, account/policy identities, original prefix records and ACL postimages. Both accounts remain disabled: NativeQual SID suffix 1008, PublicProof suffix 1009 under broker SID `S-1-5-21-1007133822-4277289207-646028416-1001`.

| Retained identity      | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Original template      | `ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10` |
| Actual continuation    | `6191a43704ec7f02d163fee2b6651e75aff39f90e79d3e01bb1a419d2fc1eccd` |
| Actual created.json    | `d8db643864d984c5d97d8d26d044e1c4373ee73020f18d026ff8dbfcd6ff9033` |
| Credentials intent     | `f440a1d9e7c3203160fcba8847552839abca8be2c70019156ce6d82127d1a05d` |
| Credentials completion | `52a985a2d6cd489e3d5046b415beb59868b348ee323f0cd5686d022533fba64d` |

The owner entered both saved passwords privately in the existing approved Credential Manager stage. Independent GET-only account readback reports both fixed targets present and format verified; passwords/logon capability remain untested. Enable intent and enabled.json remain absent. No password was collected in chat, arguments, environment or evidence.

Two prior credential invocations stopped at the combined identity/elevation check before the credential operation. A direct diagnostic in the failing owner window established the correct SID and Elevated=True. The successful launch came from an independently verified ordinary same-broker process. Neither the account guard nor the required session boundary changed. All earlier setup/profile/ACL and VHD failures remain retained.

## Actual protected Windows preparation

The independent HTTPS checkout at `C:/ProgramData/PortcoveNativeQualification/controller` has detached HEAD `0bd69c01513da9d16c7a5acbcb73dc8a064255cd`, tree `59c09c10ea67a143eb3dbc87fe2f918c8ef867b7`, clean source and autocrlf=false. Its own .git/object store has no alternates or commondir and was not cloned from E:. This is the approved controller, not the later documentation branch.

Node 24.22.1 was independently acquired from its official fixed-version HTTPS URL and verified against official SHASUMS256.txt before staged startup/promotion. The protected `tools/node.exe` is 93,915,464 bytes, SHA-256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`; manifest SHA-256 `fdfbffc969c0f604beff0124d409b33a43b53f5c681d6220f80023e0d6df9dc4`. Its actual inherited permissions give workers read/execute and broker/System full access.

Initial actual worker imports failed on missing semver. The exact pnpm 12.14.0 Windows package was then fetched independently and verified against the approved checkout's lockfile SHA-512 before extraction. Its executable SHA-256 is `62946d1c8169b8db90a73348a0b094f495eac159450f75a72a19da0321f8e6b2`. One frozen install passed: 349 packages downloaded into the private C: dependency store, copy imports, lifecycle scripts disabled, no shared E:/AppData node_modules or store objects. The package manager's message about unapproved Fallow skills did not authorize or cause a skill approval.

Fresh actual imports of release-local-worker-tasks.mts, release-native-worker.mts and release-semantic-worker.mts then passed. The collector resolved 230 loaded files, verified every physical file remains within the protected controller and has one hardlink, and retained lengths/hashes. Loaded-file inventory digest: `a56da1e7faaece77bb5f35d4006f8e554b96d430a416b44b5aff779014aa6a0d`. No worker/prepare function, candidate, configuration or credentials were passed. This proves static import readiness only; later conditional imports, full executable/OS companion closure and actual Task/native execution remain separate.

Existing bootstrap component bytes were copied into independent protected driver files. Tauri driver SHA-256 `276497b108f72a4930c12d13601754f7d68df6e9a29484d4cf07842c2fec63ab` matches its retained 2.0.6 bootstrap receipt and reviewed pin. An attempted --version check returned unsupported-argument exit1; its completed copy and original outcome remain retained. The documented --help startup passed. No CLI version observation is claimed. Protected EdgeDriver 155.0.4283.62 SHA-256 `01ce0daa683e5ea874e2e2439e4a162db11b0d40228d37cce1efc990294464f6` has a valid Microsoft signature and successful --version output matching the observed installed WebView runtime version. Neither driver was started as a server or used by a worker.

Program Files tool front-end hashes were read back: Git `54bda91c773c6bba2b970424423cfcb80552d92dc6967d766f98931fe1251a54`, PowerShell `bfb46af89433268872ddb43d1ca7a3f433452ee91ed356a9786940f90118e285`, GitHub CLI `756724853cc579510b58e65e7a7429ad6b1af29cf99ef19b3a95f3b701c5c580`. These do not replace complete companion/installation qualification.

## Actual Linux hold and exact proposed amendment

One authorized guest-start readback at 2026-10-22T19:07:59.275Z found existing Ubuntu registration `{1ce33da3-aa7d-4bd9-b178-cd18d012b76e}`, WSL2 at E:/WSL/Ubuntu, running Ubuntu 26.04 LTS and kernel 6.18.33.2-microsoft-standard-WSL2. PID1 is systemd; UID 1000 is boburning, home /home/boburning, with an existing user bus. Native name/UID/GID 1002 were absent. Bubblewrap, systemd-run and FUSE exist; Xvfb and WebKitWebDriver are absent. A diagnostic also checked /home/bobur/portcove-semantic; that wrong-home absence establishes nothing about the actual broker's semantic root.

The approved [consolidated procedure](slice4-consolidated-initial-setup-2026-10-21.md#selected-identities-and-fixed-locations) selects the existing Ubuntu registration, while its minimum and the reviewed release-native-wsl-host.mts predicate require Ubuntu 24.04. Kernel readiness cannot waive the OS requirement. Guest provisioning is held; no package, guest account, service, Task, private authentication or issuer was installed.

The [concrete amendment](https://github.com/boburning/portcove/issues/534#issuecomment-6349102401) recommends a separate **Ubuntu-24.04** registration at **E:/WSL/PortcoveSlice4Ubuntu2404**, for the existing semantic/native routes. Preserve existing Ubuntu, Docker, the observed default selection and all retained attempts. The new name is already accepted by the Task renderer; no controller-code or OS-predicate change is proposed. Installed provider inventory offers Ubuntu-24.04 and help advertises --location, --name, --no-launch and --web-download. Provider help returned 4294967295 with help bytes; that outcome is retained, not called installation success. The first collector threw on that status; a corrected read-only collector retained bytes/status. No distribution was installed.

The selection amendment is **not yet approved**. Its exact acquisition proposal is:

```text
C:\Windows\System32\wsl.exe --install --distribution Ubuntu-24.04 --name Ubuntu-24.04 --location E:\WSL\PortcoveSlice4Ubuntu2404 --no-launch --web-download
```

After approval, fresh absence/capacity checks and a create-new intent precede one bounded 10-minute acquisition from the ordinary broker. Failure/timeout/partial registration requires exact registration/path readback; no automatic retry, unregister, deletion, upgrade or default-distribution replacement. Any actual elevation/feature requirement stops and is reported. The proposal includes noninteractive absent-only broker UID/GID1000 boburning and the existing appointed native UID/GID 1002 in the new guest, followed by the original minimum/tool/cgroup/storage/TLS and same-Task inert settlement checks. No private credential placement or activation moves earlier.

## #144 real-release refresh and updated source contribution

Two exact selected public releases were reobserved; this is not a complete release inventory. Both annotated tags resolve to the commits below and both complete non-truncated root-tree reads bind the same unpatched framework `00f484fee6ace3f7f73420f0d60b0235d23af176`, with recomp-ui `b964eabe5a3438b8ed121064354ba27c1accef3f`.

| Release | Exact commit                               | Release / Windows ZIP asset | Provider SHA-256                                                   |
| ------- | ------------------------------------------ | --------------------------- | ------------------------------------------------------------------ |
| v1.0.1  | `9ae855d10a50b3f5105f3ade571b091e1eea8b63` | 420178084 /664177311        | `f46ff66f9444fb358f16db6ffcfd5d80e8f1830863e367d2f7c1cd8d38a7ffff` |
| v1.0.2  | `a3c75e2b5c00e7283cd4de771b074cd73c037011` | 420633267 /665638282        | `5d24fe9cf2ce0bb3939ee3ece16a0815fb5168f4117277ed2b0c4d3e1c840af9` |

Neither ZIP was downloaded or run in this refresh. Their source pin reuses the already reviewed unfixed framework base; neither is a repaired eligible artifact. The .35/.36 native failures and earlier .42/.43/v1.0 source evidence retain their original scopes.

The [new game contribution](patches/slice4-144-consuming-game-portable-defaults-20261022.patch) is local commit `19ce82d2e97763a1d181aad0af2eb9af8db61240`, tree `4e5e9718c2ea44befdaad86d6d02f074975d83ba`, based on actual master/v1.0.2 `a3c75e2b5c00e7283cd4de771b074cd73c037011`. It preserves the 22 incoming source/doc paths, changes only the gitlink, two version files, release notes and rebuild document, and proposes v1.0.3/v1.0.4 labels without reusing occupied public tags. These are proposed future release inputs, not two artifacts or release authority. The earlier source and patch remain retained unchanged.

Actual refreshed tests/test_release_config.py: **6 PASS**, zero failures, 0.071s. Independent nonwriting authoring_acceptance_review: **CLEAR**, bound to 19ce82d/tree 4e5e9718. Consumed framework branch still ends at 00f; the prepared backport 8c65 and recomp-ui b964 are unchanged. Prior package/runtime C++ test evidence remains reusable at that exact framework scope, not as game/package/native evidence. Explicit paths and exclusion of legacy absolute-path migration remain unchanged.

The external submission decision remains the [prepared two-contribution action](slice4-144-consuming-framework-adoption-2026-10-21.md#exact-outstanding-external-action): framework backport through boburning/psxrecomp into RetroPortingToolKit/psxrecomp:feat/native-font-localization-20261020, then the game contribution through a contributor fork into mstan/MegaManX4Recomp:master, with the actual accepted reachable framework SHA. Both proposed remote topics remain feature/portable-generated-default-adoption. The local refreshed branch is feature/portable-generated-default-adoption-102. No fork, push or external PR was performed; #685's existing grant is not expanded.

## Evidence and remaining acceptance

Local retained receipts include credentials-actual-success-20261022.json; protected-controller-preparation-20261022.log; protected-node-preparation-20261022.log; protected-pnpm-provisioned-20261022.json; protected-dependency-install-20261022.json; protected-controller-import-readiness-20261022.json (failed); protected-controller-import-readiness-20261022r2.json (passed); protected-windows-tool-freeze-20261022.json; wsl-prerequisite-readback-20261022.json; wsl-provider-install-capability-20261022.json; 144-release-source-refresh-20261022.json; and 144-consuming-refresh-config-tests-20261022.json, all under the active task's work/slice4. Protected original account/credential records, Node receipt and capture/setup-checkpoint-20261022.json remain under C:/ProgramData/PortcoveNativeQualification. No secret value is included.

Public App/installation/public-key identities, supported sign-in where required, independent offline custody and public trust material remain actual environment prerequisites. Fixed Tasks, account capability, signing, public feed/native proof and final activation retain their approved conditional ordering. D1/D2/D3, Unknown availability/headroom with no capacity reservation, account-wide $0 stop-usage and resource limits remain unchanged. #254 stays Done; #315/#534/#246 acceptance remains pending. Existing Chameleon artifact acceptance retains its scope and outstanding runtime/custody observations. #144 remains outside the compiled catalog; an unchanged capable-client baseline and initial absence must precede definition delivery. Slice 5 remains excluded.
