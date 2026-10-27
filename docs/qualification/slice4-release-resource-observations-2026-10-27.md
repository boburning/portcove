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

## Fit, margins and proposed calibration

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
