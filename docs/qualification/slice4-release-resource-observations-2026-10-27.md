# Slice 4 resource observations — October 27, 2026 UTC

This is an interim #534 audit and measurement contract. It does not ratify a new resource policy, enable a production/native job, change billing settings, or close the resource-budgeting work. The Windows producer continues while unmeasured stages remain explicitly unknown.

## Provider billing and repository policy

As checked October 27, GitHub documents standard GitHub-hosted runner usage in public repositories as free. Larger runners remain paid. The public repository identity was read back as 1354613114/boburning/portcove. This does not prove storage headroom, account settings, provider availability or a reservation. Preserve the account-wide $0 stop, standard-runner restriction and no-paid-fallback admission. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [usage](https://docs.github.com/en/actions/concepts/billing-and-usage), [provider limits](https://docs.github.com/en/actions/reference/limits).

GitHub has a six-hour hosted job limit; workflow/job timeouts can be shorter. A job without a declared timeout defaults to 360 minutes. These provider bounds are different from the local 100 aggregate-job-minute policy. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes).

The 100 figure entered the resource object in [PR #2125](https://github.com/boburning/portcove/pull/2125), commit dbf8f979b90ca4513d46dca7ff766fea12d1f2d3. Its dated packet totals 85 aggregate minutes (5/25/30/5/20) plus 15 input minutes (5/5/5), explicitly as reviewed ceilings/estimates, not observed headroom or allocation. The bounded history inspected supplies no empirical or GitHub billing derivation for 100. Historical D2 review does not ratify later changed workflow/resource digests.

## Current declared inventory

`node scripts/release-resource-observation.mts` derives this inventory from the maintained production, wake and candidate workflows and compares the existing policy arrays/digests. It is data-only; new jobs surface policy drift rather than silently extending admission. All duration cells below are Unknown unless separately measured. Declared minutes are runner-time ceilings, not wall time, actual usage or billable minutes.

| Job key                                   | Purpose                            | Current maximum minutes | Observed current production duration |
| ----------------------------------------- | ---------------------------------- | ----------------------: | ------------------------------------ |
| `admission`                               | application, catalog               |                       1 | Unknown                              |
| `tool_bootstrap`                          | application, catalog               |                       4 | Unknown                              |
| `tool_attest`                             | application, catalog               |                       2 | Unknown                              |
| `tool_bootstrap_windows`                  | application                        |                       4 | Unknown                              |
| `classification_protection_observation`   | application                        |                       2 | Unknown                              |
| `classification_writer`                   | application                        |                       2 | Unknown                              |
| `coordinator`                             | application, catalog               |                       3 | Unknown                              |
| `coordinator_protection_observation`      | application, catalog               |                       3 | Unknown                              |
| `independent_admission`                   | application                        |                       9 | Unknown                              |
| `protection_observation`                  | application                        |                      10 | Unknown                              |
| `attest`                                  | application                        |                       2 | Unknown                              |
| `native_linux`                            | application                        |                      10 | Unknown                              |
| `payload_signing`                         | application                        |                      10 | Unknown                              |
| `tuf_releases`                            | application                        |                       2 | Unknown                              |
| `tuf_preview`                             | application                        |                       2 | Unknown                              |
| `tuf_stable`                              | application                        |                       2 | Unknown                              |
| `tuf_snapshot`                            | application                        |                       2 | Unknown                              |
| `tuf_timestamp`                           | application                        |                       2 | Unknown                              |
| `release_publication`                     | application                        |                       6 | Unknown                              |
| `site_publication`                        | application, catalog               |                       5 | Unknown                              |
| `site_protection_observation`             | application, catalog               |                       5 | Unknown                              |
| `catalog_definitions`                     | catalog                            |                       2 | Unknown                              |
| `catalog_policy`                          | catalog                            |                       2 | Unknown                              |
| `catalog_snapshot`                        | catalog                            |                       2 | Unknown                              |
| `catalog_timestamp`                       | catalog                            |                       2 | Unknown                              |
| `catalog_metadata_protection_observation` | catalog                            |                       8 | Unknown                              |
| `wake`                                    | mutually exclusive controller wake |                       1 | Unknown                              |

Application allocation is66 aggregate+22 input/observer+1wake=89. Catalog is an alternative23+16+1=40, not an additional40. Current unallocated policy space is11 minutes. The planned single ten-minute Windows native job would make99, but that arithmetic is not execution-fit evidence. The production workflow currently contains no Windows native job.

## Separate candidate and recovery workflows

The controller envelope excludes candidate compilation/qualification and report repair. `release.yml` declares the following jobs; matrix cells multiply runner-time and reusable workflows have their own jobs. The dynamic build matrix must be resolved against its exact release profile before claiming a candidate-wide maximum.

| Job key                 | Purpose/name              | Current maximum per job/cell | Selection/coverage                                                            |
| ----------------------- | ------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `identity`              | identity                  | 2 / 360                      | `${{ inputs.report_only_repair && 2                                           |     | 360 }}` |
| `qualification`         | qualification             | reusable declaration         | `./.github/workflows/qualification.yml`                                       |
| `validate`              | validate                  | 360                          | `provider-default360`                                                         |
| `build`                 | Build ${{ matrix.label }} | 60 / 360                     | `${{ needs.identity.outputs.release_profile == 'initial-beta-win-linux' && 60 |     | 360 }}` |
| `build_intel`           | build_intel               | 360                          | `provider-default360`                                                         |
| `verify_intel`          | verify_intel              | 360                          | `provider-default360`                                                         |
| `release_gate`          | release_gate              | 360                          | `provider-default360`                                                         |
| `assemble`              | assemble                  | 360                          | `provider-default360`                                                         |
| `rehearse`              | rehearse                  | 360                          | `provider-default360`                                                         |
| `attest`                | attest                    | 360                          | `provider-default360`                                                         |
| `authorize_publication` | authorize_publication     | 360                          | `provider-default360`                                                         |
| `publish`               | publish                   | 360                          | `provider-default360`                                                         |

`identity` is2 minutes for report-only repair and360otherwise. `build` is60 minutes per initial-beta cell and360otherwise. Non-repair identity and several non-build jobs inherit or declare the provider maximum; those values have no measured justification in this audit. Nested qualification is outside the controller envelope and is not flattened by the advisory command; its selected-attempt measurements below retain their actual complete job inventories. No unrelated CI modernization is proposed.

Report repair remains at most two dispatches×2 minutes=4 minutes per candidate, separately bounded. It repairs reports, not runtime/native failures, and cannot enlarge or silently retry the controller DAG.

## Hosted observations and limits

Ordinary source/tool run[40435551343/1](https://github.com/boburning/portcove/actions/runs/40435551343), source4b587ec42e9ec6584f248114f74a6ddcd51d1cc5:

| Component                               | Observed runner seconds | Boundary                                                                           |
| --------------------------------------- | ----------------------: | ---------------------------------------------------------------------------------- |
| Windows source/tool fixture             |                     337 | Includes cold job setup, tooling, source/dependency readback and controls          |
| Linux source/tool fixture               |                     279 | Includes tooling plus 53 seconds of additional disposable-channel/runtime controls |
| Aggregate of those two jobs             |                     616 | Sum of overlapping runner durations; not billable minutes                          |
| First job start through last completion |                     337 | Observed execution envelope, not an end-to-end production release                  |
| Windows source/dependency readback      |                  91.461 | Within the separate 180s dependency phase;11graph controls passed/0skips           |

The Windows qualification step was 282 seconds; checkout/pnpm/Node/Rust setup consumed 9/15/6/14 seconds. Linux qualification was 189 seconds and its additional runtime controls 53 seconds. These larger fixture scopes are not equivalent to the production four-minute bootstrap jobs. Existing Linux builder timing and the new shared per-phase observations distinguish package-manager acquisition, Microsoft driver acquisition, bundling, Rust/WebDriver builds, inventory and source closure. Failure timelines are retained without retry/adoption. Cold workflow setup remains a separate provider observation.

The first phase-instrumented run [40448036048/1](https://github.com/boburning/portcove/actions/runs/40448036048) supplies the following actual component measurements. Windows executed source `411ad2ad491ccbec7e3b7570b580594a744da8d4`; Linux executed synthetic PR merge `8bcca0b9f111b0aec76da1d9057d4f2349c4405a`. Independent commit readback joins both to tree `0b4843ae7daa1715c436458e847ba7809d3bfd03`. The two-job attempt inventory is complete, with unique job IDs and completed timestamps. Both public evidence archives passed exact compressed-length/SHA-256, bounded raw ZIP inventory, expanded-length/CRC and JSON/source checks.

| Component                                                        | Windows seconds | Linux seconds |
| ---------------------------------------------------------------- | --------------: | ------------: |
| Builder entry through complete inventory                         |         241.199 |        87.903 |
| Rust build phase, from consecutive cumulative phase boundaries   |         191.553 |        74.214 |
| Native WebDriver build phase, same boundary method               |          40.047 |         8.584 |
| Job start through qualification step start, including cold setup |              69 |            15 |
| Full ordinary fixture job, including additional controls         |             475 |           176 |

Phase timestamps are cumulative monotonic observations, not separate job allocations. These two overlapping jobs consumed 651 aggregate runner seconds and a 475-second execution envelope. Neither number establishes billable usage or production wall time. Windows artifact `12708679797` is 25,722 bytes/SHA-256 `00b0bfd3ff6f30fde3270ac03d4c929411bfabde8f38b6c66be3299237ca8b9e`; Linux artifact `12709426507` is 18,076 bytes/SHA-256 `ad1647dc47c353a424e4ce5e2eee15f9571d0813c2464a7cc27746b88d2dedd0`.

Unlike the larger whole-fixture totals, the Windows builder's 241.199 seconds alone exceeds the current four-minute bootstrap ceiling before cold job setup, archive/upload or ordinary variance. This is direct component evidence against that ceiling, not an observed production timeout. Linux's 87.903 seconds is inside its separate 210-second build allowance; this one observation does not justify reducing its active four-minute job budget. The corresponding CI attempt failed an existing inert form observer after 60 seconds without a visible window, with root exit, empty job and drained observer confirmed; that is a separate fixture failure, not native or production qualification. Bounded startup diagnostics were added without weakening visibility assertions or extending its timeout.

Selected historical `release.yml` attempt inventories were enumerated through the attempt-specific jobs endpoint: first page <100, stable reported total, unique opaque IDs and completed run/source/attempt readback. The sample is the latest two failed runs plus one earlier successful run from a bounded latest-ten query; it is not complete repository history. [Endpoint contract](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt).

| Run/attempt                                                                     | Result  | Complete jobs / executed | Aggregate runner seconds | Execution envelope seconds | Identity seconds |
| ------------------------------------------------------------------------------- | ------- | -----------------------: | -----------------------: | -------------------------: | ---------------: |
| [40013590472/1](https://github.com/boburning/portcove/actions/runs/40013590472) | failure |                  47 / 29 |                    11970 |                       2012 |               42 |
| [39988145461/1](https://github.com/boburning/portcove/actions/runs/39988145461) | failure |                   12 / 2 |                       29 |                         32 |               14 |
| [35158181486/1](https://github.com/boburning/portcove/actions/runs/35158181486) | success |                  48 / 37 |                    10233 |                       1416 |               12 |

The 199.5-minute aggregate historical failed qualification and 170.55-minute earlier successful workflow show why 100 is not an account-wide usage meter. The historical successful workflow did not execute a fresh current candidate build; skipped jobs and failures remain separate. None supplies current protected/native, signing, full opportunity, release or recovery acceptance.

Two existing runtime-readiness attempts supply a separate component measurement:

| Run/attempt                                                                     | Source                                     | Runtime preparation/readback step seconds | Whole job runner seconds | Other scope                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------: | -----------------------: | ------------------------------------------------------------------------------ |
| [39869470925/1](https://github.com/boburning/portcove/actions/runs/39869470925) | `82f5639fa5a58587fa5e9221a6a72ca4c6724f63` |                                        52 |                       67 | Runtime prerequisite only                                                      |
| [39873457327/1](https://github.com/boburning/portcove/actions/runs/39873457327) | `12f6b1305aa4b15db9e33c06164247ee9e1f9f66` |                                        67 |                      187 | Adds62seconds cold/warm driver-only qualification and separate Node/Rust setup |

The complete attempt-specific job inventories each contain one successful job with its exact source and unique job identity. These are provider step intervals; installer-only time is not separately observed. Earlier retained diagnostic receipts establish the first run's131→156 runtime change; those artifact bytes were not reread for this timing inventory. Neither run executes the new original Windows producer/candidate/session pipeline. The existing diagnostic preparation currently permits60seconds download plus300seconds installer execution, then readback; its reviewed diagnostic workflow gate is unchanged. Its source-defined bound is not a measured six-minute workload or an additional reservation.

Current Windows/Linux native pre/post qualification, actual signing, publication, mandatory recovery and whole-job distributions remain unmeasured in the held pipeline. Existing inert/legacy observations keep their original scope. Component success and old workflow duration cannot fill those gaps.

## Offline runtime source measurement and diagnostic telemetry

An October27 read-only local source probe followed the x64 Evergreen Standalone Installer link published by [Microsoft's download page](https://developer.microsoft.com/en-us/microsoft-edge/webview2). The retained60993-byte HTML and its statically read component identify `https://go.microsoft.com/fwlink/?linkid=2124701`; no downloaded page code was executed. One bounded HEAD redirect resolved to Microsoft's HTTPS delivery host. A separate nonredirecting GET retained the exact214884560-byte package under a256MiB/120second local bound, SHA256 `1c401b327fbc7bb9731b4e350a2194f083cbc3ede46508d52e1cae6610a39bea`. Local download elapsed1982ms; this is not a hosted-runner or installer measurement.

Windows read-only Authenticode verification returned Valid for Microsoft Corporation, certificate thumbprint `4028CAD637509D4744B17EC5B42AED8D7A31E6AF`; Windows and WSL SHA256 readbacks matched. Verification/PE metadata/hash observation took16253ms locally. PE resources identify Microsoft Edge Update1.3.303.7 / MicrosoftEdgeUpdateSetup.exe. That is the installer wrapper version; the enclosed WebView2 runtime version remains Unknown. The package was not executed or extracted. Signature/source metadata does not establish runtime eligibility, exact driver matching, original custody or native acceptance.

The package alone exceeds the existing128MiB per-tool-file bound. Adding it unchanged to the latest observed279657359-byte Windows tool inventory would total494541919bytes, exceeding the existing320MiB expanded-tool bound. Those bounds remain unchanged. A prospective offline preparation route therefore needs an exact reviewed storage/provenance proposal, not a silent larger artifact or a claim that the current bundle already fits. Microsoft's [distribution contract](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) distinguishes offline Evergreen installation from Fixed Version deployment; switching runtime ownership or disabling updates is not authorized by this probe.

The existing diagnostic helper now records cumulative monotonic phases after its unchanged workflow gate: initial registry readback, optional download/disposal, signature/hash verification, optional installer start/disposal, post-install readback, refusal and terminal receipt readiness. Its existing intermediate pre-install and final success/failure receipts retain these observations. Cold runner setup and final receipt serialization/write are explicitly excluded. The60second download and300second installer bounds, floor, signature, workflow identity, single-attempt refusal and failure handling remain unchanged. Controlled existing-runtime/conflicting-registry tests invoke no installer; actual hosted installer-phase timings remain Unknown until an authorized diagnostic runs. No new diagnostic dispatch or production activation is included.

## Fit, margins and proposed calibration

### October 28 — held standalone source preparation

The existing runtime-readiness diagnostic now has a false-default
`use_standalone_installer` input. Selecting it still refuses before evidence,
network or installation because the helper's separately reviewed execution gate
is literal `false`. No workflow input, downloaded record or digest can open it.
The ordinary bootstrapper path keeps its existing gate and behavior.

The prepared alternate consumes the exact official x64 source observed above:
214,884,560 bytes / SHA-256
`1c401b327fbc7bb9731b4e350a2194f083cbc3ede46508d52e1cae6610a39bea`.
It follows at most one HTTPS redirect from the fixed Microsoft link to the
declared Microsoft delivery host, refuses further redirects/encoding, streams
under a 256-MiB ceiling and one 120-second download deadline, and requires exact
size/hash plus valid Microsoft Authenticode before the existing installer path.
It repeats that identity/signature check immediately before launch. The original
five-minute installer limit, post-install shipping-floor readback, retained
failure, single attempt and no-retry behavior remain. Every attempted download
retains its proposed identity and bounds before acquisition; interrupted owned
partials remain evidence. The installer stays outside the controller-tool bundle
and is excluded from the diagnostic artifact's JSON-only upload. The 128-MiB
per-tool and 320-MiB expanded-tool limits remain unchanged.

The source descriptor keeps `runtime_version: null`. Microsoft's
[Evergreen distribution documentation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
distinguishes the full offline installer from Fixed Version deployment. Its
[pinned WinUI maintenance guidance](https://github.com/microsoft/microsoft-ui-xaml/blob/b9fa30e549de859f15fb84f153cc6136b981d10a/controls/dev/WebView2/WebView2-update.md)
also distinguishes the enclosed runtime version from the outer Edge Update
wrapper. No wrapper-version substitution, Fixed Version switch, runtime approval
or redistribution right is inferred here.

Thirteen inert full-helper scenarios exercise held selection, bounded successful
copy, foreign/second redirect, declared/actual length, encoding, cancellation,
interruption, changed bytes, missing signature and pre-launch substitution.
Only private fixture copies alter host/source pins and open the gate, with inert
HTTP/signature/process peers; actual file/stream/hash and success/failure receipts
remain exercised. A separate control executes the maintained workflow step with
inert helper peers to check boolean mapping and reject interpretation as code.
These are controlled framework checks, not a real installer, runtime, hosted
timing or production observation.

Resume real standalone qualification only after the exact source/storage and
bounded diagnostic execution scope is independently reviewed and authorized.
Then retain actual signature, installer result, runtime version, matching driver,
loaded-engine and measured timing/custody identities. This preparation neither
activates the protected Windows job nor supplies complete-opportunity, grant,
signing/publication or unchanged-client acceptance. Production and resource
ratification remain held; no new diagnostic dispatch occurred.

A 99-minute sum does not establish that either native job fits ten minutes. The Windows preparation caps 90+180+90=360 seconds plus the existing210-second capture/recovery reserve already total570 seconds before cold setup. Waiting for a separately bounded payload signer may add up to its own 570-second role window after pre-sign readiness. Those maxima cannot all fit one 570-second native execution window. Issuer expiry can shorten it further. Do not remove custody checks, mandatory qualification or cleanup to force that arithmetic.

The recommended model is a named per-job plan with explicit purpose membership, measured equivalent cold/hot workloads, bounded upstream wait dependencies and mandatory cleanup reserves. Derive each purpose envelope from that plan rather than selecting 100 or another unrelated scalar. Keep candidate compilation and report-repair accounting separately visible. An added platform must produce a drift finding and a new exact digest/ratification; it must not silently increase active authority. Per-job margins should use observed maxima and meaningful variance samples, plus deterministic mandatory waits and recovery, not a claimed percentile from one run.

Interim recommendations, not activation:

- Candidate `identity`: propose a five-minute normal-job ceiling, retaining the existing two-minute report-repair bound. Three historical observations 12/14/42 seconds leave 258 seconds over the largest observation; this is provisional until an equivalent current normal run confirms the workload. Do not lower build or reusable qualification ceilings from this sample.
- Source bootstrap: prepare an eight-minute Windows job proposal against the observed 241.199-second builder and 69-second cold setup. Its 480-second ceiling would leave 169.801 seconds beyond that measured 310.199-second subtotal for packaging/upload and runner variance. Those operations are not yet measured equivalently, so this is a provisional component proposal, not a qualified complete-job guarantee. Keep Linux at four minutes pending equivalent repeated cold measurements. Neither active timeout nor digest changes here.
- Native: withdraw the assumption that ten minutes is proven sufficient. A provisional 25-minute planning allowance can cover the known 6-minute preparation caps, 9.5-minute signer window and 3.5-minute existing capture/recovery estimate, with 6 minutes left for cold setup, proof I/O and variance. The capture/recovery estimate is not measured; 25 is not yet a qualified or ratified production recommendation. Gather the actual connected stage timings before finalizing it.
- Windows runtime preparation: account explicitly for the separate download/installer/readback boundary before finalizing native ceilings. The52/67second diagnostic steps do not justify truncating its mandatory recovery or slow-download allowance. If its60+300second caps are composed serially with the19minutes of preparation/signer/capture estimates above, the25minute planning example has no remaining margin even before readback, setup or proof. Do not qualify that example as sufficient for Windows; runtime preparation and matching-driver custody still need a reviewed connected implementation and measurements.
- Aggregate: derive the prospective envelope after native per-job calibration. Keeping all other current allocations while assigning both native jobs 25 minutes would produce 129 application minutes (89 + 15 Linux increase + 25 Windows addition). Including the proposed Windows bootstrap increase from four to eight would produce 133, with catalog 40 and report repair 4 separate. This is a reviewable planning example, not a new hard limit or a reservation. The exact workflow/resource/inner-deadline changes require the final measured proposal and owner ratification.

## Failure behavior and preserved controls

Admission checks the exact ratified resource/workflow/source tuple, provider/account/$0facts and unresolved effects. It refuses changed, pending, ambiguous or unavailable boundaries. It does not continuously total 100 minutes of elapsed work across the account. Workflow timeouts and inner original monotonic/issuer deadlines stop jobs/operations. GitHub may cancel or terminate work; finally/cleanup is not guaranteed after a hard kill. Keep failed/partial receipts and pending effects, block automatic reuse and use the exact owned recovery route. A requested or attempted cleanup is not proof that cleanup completed.

This observation component changes no workflow timeout, resource-policy object/digest, signing boundary, protected scope or account setting. It adds no paid runner/service, spending permission, fallback, cache enlargement or retention increase. Existing concurrency, archive/storage, retention, request and recovery bounds remain. Availability/headroom stay Unknown and reservation stays None.

The resource work remains open until connected native/signing/publication/recovery observations support final margins, the proposed canonical budget is independently reviewed and any changed exact digests/scopes receive required ratification. Continue Windows implementation while gathering measurements; do not dispatch held production work merely to fill this table.

### October 28 — actual prerequisite qualification at current source

The existing ordinary diagnostic routes were exercised once at source
`388ac0a3394ab5e3cca80d24233be2b837883653`, tree
`1888874d47f91f460b07f44fde1b1f9ac3968672`, without opening standalone or protected
execution. Complete attempt-specific job inventories and exact public artifact
bytes were retained. These observations measure diagnostic jobs, not the complete
protected controller or provider billing/headroom.

[Windows 40650089592/1](https://github.com/boburning/portcove/actions/runs/40650089592),
job `122687893386`, took 151 seconds. Actual registry readback changed from
131.0.2903.86 to 156.0.4314.50; the ordinary Microsoft bootstrapper exited zero.
Its SHA-256 was `13f6d9cdc8c3e7186e4b180db7f48e199ee97d631480e8391fb3106f338fb21a`,
Microsoft signer thumbprint `4028CAD637509D4744B17EC5B42AED8D7A31E6AF`.
The runtime step took 52 seconds; the monotonic receipt measured 50,865 ms,
including 50,167 ms from installer start through process disposal. Combined cold
and warm driver setup took 62 seconds; individual phase durations were not
recorded. Actual EdgeDriver 156.0.4314.50 matched WebView2, SHA-256
`dd728c934e491abe7e8a07fa366aad135ea15d934cbba99192ad872da59c39d3`;
Tauri driver 2.0.6 SHA-256
`c986283281576c6649c1c9e1e0786e3fa0cb5422372541ef3bd37d569106c443`.
The maintained helper verified unchanged cold/warm driver identities and hashes.
Artifact `12799068760`, 1,431 bytes, SHA-256
`42b603186a0fcc212bcefad9581a7f736b0926f3da4878327ff0473ce7ecaf30`,
contains two fully inspected JSON files; expiry is November 4. This establishes
ordinary runtime/driver prerequisites, not standalone execution, candidate
startup, loaded-engine observations or native acceptance.

[Linux 40649685268/1](https://github.com/boburning/portcove/actions/runs/40649685268),
job `122686601304`, took 30 seconds; preparation and the inert primitive probe
took 21 seconds. Actual WebKitGTK and WebKitWebDriver were both
2.52.6-0ubuntu0.24.04.1, amd64. Ten package versions, five executable identities,
exact source/helper/profile joins and 37 passing inert Python controls were
retained. The original cgroup device/inode 31/7442 was removed and original unit
invocation `6852573aff95459c9d8780abf5457418` settled. Launcher exit 255 is
intentional teardown, not candidate exit zero. The 100 opaque AppArmor
attachments remain unresolved at their recorded scope; positive cgroup cleanup
does not erase that uncertainty. Artifact `12799236909`, 76,230 bytes, SHA-256
`1d38656808d6ed5b9d95ea8385af9a466fe56f99ef471d0d10ec08c2f9ffdbfb`,
contains 19 fully inspected files; expiry is November 4. These are actual runtime
inputs, source custody and inert isolation primitives, not loaded candidate or
protected acceptance. The initial old-source dispatch preflight refused before
POST when main advanced; no retry or dispatch occurred for that old source.

The Windows tool fixture now prepares the supported ordinary runtime before
building its exact driver-bearing source bundle. Its pre-mutation guard binds the
fixed workflow/job and clean actual checked-out head, preserving the PR head
separately from GitHub's synthetic merge identity. The tool qualifier must join
that runtime receipt to the actual driver version, source, run and attempt.
Standalone remains refused on this fixture route. The fifteen-minute fixture job,
ordinary 60-second download/five-minute installer bounds, tool bounds and all
production gates are preserved. Actual connected tool-fixture fit is separately
required. The historical 100 aggregate-job-minute ceiling remains repository
policy; these measurements neither raise it nor turn it into a billing limit.
