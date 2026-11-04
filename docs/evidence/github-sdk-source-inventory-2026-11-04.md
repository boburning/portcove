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
