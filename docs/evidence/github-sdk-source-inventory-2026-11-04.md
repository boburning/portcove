# GitHub SDK source inventory, November 4, 2026

Owner and remaining delivery scope: [#4319](https://github.com/boburning/portcove/issues/4319).
This records the foundation source boundary, not whole-migration acceptance.
The foundation resumes from main d8c008c2c1eaae9a603c1104bb1301adbd7b8d4f;
PR #4320's squash-delivered redaction repair is retained.

| Maintained source                                                     | Foundation outcome                                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/github-client.mts`                                           | One configured credential-scoped Octokit integration, bounded metadata and attempt evidence.                                                                                     |
| `scripts/github-operation.mts`                                        | Pure errors, envelopes, redaction, response metadata and pagination-link interpretation.                                                                                         |
| `scripts/github-cli.mts`                                              | Bounded local credential resolution and cryptographic attestation verification, without an API command path.                                                                     |
| `scripts/github-rest-inventory.mts`, `repository-issue-inventory.mts` | Awaited REST inventory, authenticated cache validation, identity/filter continuity and completeness proof; failed logical-page allowances survive recovery.                      |
| `scripts/roadmap-rest-intake.mts`, `roadmap.mts` capture-port         | Production asynchronous REST inventory, canonical issue creation receipt, Project mutation and exact readback.                                                                   |
| `scripts/aqua-integrity.mts`                                          | SDK release metadata; existing Aqua invocation retained.                                                                                                                         |
| `scripts/handoff-evidence.mts`                                        | SDK selected-PR read with unchanged output/unknown semantics.                                                                                                                    |
| `scripts/postmerge-ci.mts`, `select-ci-plan.mts`                      | Awaited SDK metadata, narrow domain fake, lazy optional imports for dependency-free planning; push observation installs the frozen dependency set before credentialed execution. |
| `scripts/ci-health.mts`                                               | SDK metadata/pagination under request and aggregate bounds.                                                                                                                      |
| `scripts/github-controller-attestation.mts`                           | Retained verifier separated from the retiring API runner; owner supplies deadline and environment.                                                                               |

Actual locked-package tests exercise the configured SDK rather than fabricating
SDK results. REST and postmerge domain fixtures use asynchronous read/write
operations rather than CLI argument arrays or included-HTTP strings. SDK package
identity comes from the manifest and lockfile, without a second version registry.
The Fallow boundary prohibits new integration dependencies on domain modules.

Unmigrated Roadmap, delivery, discovery, upstream, release, workflow and native
callers remain under their existing owners until the later approved slices.
The legacy `github-api.mts` API runner and its still-used fixtures therefore remain.
Ordinary CI/postmerge artifact-byte acquisition retains the existing bounded
`github-binary.mts` path for the release acquisition slice. Git operations, Aqua,
credential resolution and attestation are retained non-API operations.

This inventory was checked through source imports and targeted integration tests;
import counts do not establish independent networking integrations or completeness.
No native, protected-release, installed-runtime or activation acceptance is claimed.
#4306 stays closed; #534's ownership and production pause remain unchanged.

## Follow-up inventory

Current delivery receipts and exact source heads are recorded in [#4319](https://github.com/boburning/portcove/issues/4319).
The foundation table above describes the initial source boundary.

| Surface                  | Ownership and verification boundary                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node tooling             | The configured Octokit client supplies bounded metadata and request evidence. Roadmap, discovery, delivery, release inventory and recovery own completeness and readback.                                                           |
| Workflow-only operations | Fixed trusted scripts use pinned `actions/github-script` with retries and debugging disabled. Workflow permissions and source selection remain with the owning workflow.                                                            |
| Core GitHub provider     | Octocrab uses the configured reqwest API and anonymous device transports. Core owns the 4 MiB metadata cap, release and credential policy, and the separate download client.                                                        |
| Local App setup          | Scoped Octokit preserves exact private response custody and preflights the locked SDK before beginning a one-shot attempt.                                                                                                          |
| Qualification            | The frozen reboot Node acquisition supplies exact archive and tuple evidence to offline Python validation. A live replay requires the original artifact or an owner-ratified replacement.                                           |
| Binary transfers         | API lookup and authorization stay with the applicable SDK owner. Approved archive and asset downloads retain bounded streaming and identity checks.                                                                                 |
| Retained CLI operations  | Git, eligible credential resolution and cryptographic attestation verification retain their narrow execution boundaries. The local daily-discovery session resolves its existing CLI login once under its own host and time bounds. |

The legacy transport remains open for the held reviewed-input helper,
shared catalog and recovery paths, and the semantic worker service. Their
source and setup authority remain separate under [#534](https://github.com/boburning/portcove/issues/534).
The WSL worker service path needs a frozen dependency closure provisioned before
credentials and bound to the exact successor setup and worker revisions. The
sealed semantic and native Check issuer child has a sibling SDK entry point at
`scripts/release-semantic-issuer-sdk-http.mts`. The current issuer owners retain
their original child. Before switching, bind the successor executable and all
resolved SDK files to both owners' exact custody, provision the frozen dependency
closure before credentials, and qualify the bounded stdin and private response
pipe through both owners. The connected Windows diagnostic source gate
is held and its current external closure admits only the pinned YAML dependency.
The held reviewed-input and pre-tool launcher contracts remain part of the
retirement inventory. The standalone reviewed-input `read` mode had no maintained
caller and is retired.
The r5 rehearsal has retired as a separate migration gate. Its executable
workflow and last CLI release-asset reader were removed from main. The historical
tag still resolves to `bf4fd225c5347ec4177afc9235bef5d1ee57e064`, and #534
owns the unfinished uninstall and public readback claims.
[Recorded decision](https://github.com/boburning/portcove/issues/4319#issuecomment-6699780365).

The maintained-source guard checks recognized CLI API patterns and caps the
number of legacy references in each recorded source file. The listed legacy
users remain migration work.
