set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

storage := "node scripts/dev-storage.mts run --"

# The no-argument developer loop is the complete diff-selected local plan.
default: local-check

preflight:
    node scripts/dev-storage.mts preflight

doctor *args:
    node scripts/dev-doctor.mts {{args}}

# Passive snapshots of existing validation guards; never resource admission.
resource-status *args:
    node scripts/resource-status.mts {{args}}

# Advisory pull request metadata check; requires GitHub authentication.
pr-check *args:
    node scripts/pr-conventions.mts --pr {{args}}

# One-shot, fail-closed classification and metadata validation for routine Renovate PRs.
renovate-check *args:
    {{storage}} node scripts/pr-delivery.mts renovate-check {{args}}

# Exact-head REST observation and guarded normal merge for a qualified pull request.
pr-watch *args:
    node scripts/pr-delivery.mts watch {{args}}

pr-merge-rest *args:
    node scripts/pr-delivery.mts merge {{args}}

development-tools:
    # node-suite: development-tools
    {{storage}} node --test --test-concurrency=2 --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/validation-evidence.test.mts scripts/resource-capacity.test.mts scripts/resource-command.test.mts scripts/container-browser.test.mts scripts/container-build.test.mts scripts/desktop-listener-probe.test.mts scripts/container-recovery.test.mts scripts/checked-git.test.mts scripts/resource-status.test.mts scripts/report-summary.test.mts scripts/ci-metrics.test.mts scripts/checkout-context.test.mts scripts/github-body.test.mts scripts/audit.test.mts scripts/audit-evidence.test.mts scripts/audit-archive.test.mts scripts/audit-reuse.test.mts scripts/desktop-build-cache.test.mts scripts/desktop-scenarios.test.mts scripts/native-compatibility.test.mts scripts/desktop-execution-plan.test.mts scripts/desktop-execution-baseline.test.mts scripts/desktop-real-runtime.test.mts scripts/desktop-linux-native-session.test.mts scripts/desktop-linux-stop.test.mts scripts/desktop-verify.test.mts scripts/dev-doctor.test.mts scripts/development-capabilities.test.mts scripts/development-cli-help.test.mts scripts/development-evidence.test.mts scripts/retained-package.test.mts scripts/capture-target.test.mts scripts/handoff-evidence.test.mts scripts/native-confirmation.test.mts scripts/native-helper-dependencies.test.mts scripts/frontend-command-preflight.test.mts scripts/windows-helper-checks.test.mts scripts/heavy-rust-test-lock.test.mts scripts/local-validation.test.mts scripts/precommit-check.test.mts scripts/run-oxlint.test.mts scripts/native-session-lock.test.mts scripts/native-session.test.mts scripts/process-lock.test.mts scripts/renovate-fast-lane.test.mts scripts/repository-skills.test.mts scripts/run-rust-tests.test.mts scripts/rust-support-cache.test.mts scripts/rust-test-impact.test.mts scripts/rust-test-tree-supervisor.test.mts scripts/tool-cache.test.mts scripts/fixture-module-closure.test.mts

# Complete selected local loop; required hosted CI runs its separately selected plan.
local-check *args:
    {{storage}} node scripts/local-validation.mts check {{args}}

test-rust *args:
    {{storage}} node scripts/local-validation.mts test-rust {{args}}

test-ui-related *args:
    {{storage}} node scripts/local-validation.mts test-ui-related {{args}}

# Literal test files, reconciled against the executed Vitest report.
test-ui *args:
    {{storage}} node scripts/local-validation.mts test-ui {{args}}

test-node *args:
    {{storage}} node scripts/local-validation.mts test-node {{args}}

desktop-test *args:
    {{storage}} node scripts/desktop-test-cli.mts {{args}}

# Build, isolate, select, and retain native desktop verification evidence.
desktop-verify *args:
    {{storage}} node scripts/desktop-verify.mts {{args}}

# Windows external-reference client; requires Visual Studio Build Tools.
playnite-check *args:
    {{storage}} pwsh -NoProfile -File integrations/playnite/check.ps1 {{args}}

# Optional early feedback; these do not replace hosted or installed acceptance.
cli-help-check:
    {{storage}} node scripts/run-rust-tests.mts --guard-command cargo test --locked -p portcove-cli --test machine_contract installation_and_external_help_explain_review_binding_and_file_ownership -- --exact

playnite-contract-check *args:
    {{storage}} pwsh -NoProfile -File integrations/playnite/check.ps1 -ContractsOnly {{args}}

handoff-check *args:
    node scripts/handoff-evidence.mts check {{args}}

# Optional Windows Docker Desktop / WSL 2 browser tooling (#2006).
container-doctor:
    node scripts/container-browser.mts doctor

container-browser *args:
    node scripts/container-browser.mts run {{args}}

container-export *args:
    node scripts/container-browser.mts export {{args}}

container-clean *args:
    node scripts/container-browser.mts clean {{args}}

# Optional Ubuntu 22.04 checks/unsigned packages (#2007).
container-build-doctor:
    node scripts/container-build.mts doctor

container-build *args:
    node scripts/container-build.mts run {{args}}

container-build-export *args:
    node scripts/container-build.mts export {{args}}

container-build-clean *args:
    node scripts/container-build.mts clean {{args}}

clean-build:
    node scripts/dev-storage.mts clean

# Explicit storage recovery; ordinary validation preserves incremental reuse.
prune-incremental:
    node scripts/dev-storage.mts prune-incremental

# Repository formatting
fmt:
    {{storage}} cargo fmt --all
    {{storage}} node scripts/run-viteplus.mts fmt

fmt-check:
    {{storage}} cargo fmt --all -- --check
    {{storage}} node scripts/run-viteplus.mts fmt --check

# Rust fast loop
rustfmt-check:
    {{storage}} cargo fmt --all -- --check

rust-check:
    {{storage}} node scripts/run-rust-tests.mts --guard-command cargo check --workspace --all-targets

clippy:
    {{storage}} node scripts/run-rust-tests.mts --guard-command cargo clippy --workspace --all-targets -- -D warnings

rust-test:
    {{storage}} node scripts/run-rust-tests.mts --locked --workspace
    {{storage}} node scripts/run-rust-tests.mts --guard-command cargo test --locked --workspace --exclude portcove-desktop --doc
    {{storage}} node scripts/run-rust-tests.mts --guard-command cargo test --locked -p portcove-desktop --doc

shear:
    {{storage}} cargo shear --deny-warnings

architecture:
    # node-suite: rust-quality-full
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/check-rust-architecture.test.mts
    {{storage}} node scripts/check-rust-architecture.mts

process-policy:
    # node-suite: process-policy
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/check-child-process-policy.test.mts
    {{storage}} node scripts/check-child-process-policy.mts

transport-contract:
    # node-suite: transport-contract
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/check-transport-contract.test.mts
    {{storage}} node scripts/check-transport-contract.mts
    # node-suite: rust-quality-full-2
    {{storage}} node --test --test-reporter=./scripts/required-node-test-reporter.mts scripts/check-transport-contract.integration.test.mts

check-rust: rustfmt-check clippy rust-test shear architecture process-policy transport-contract

# Frontend fast loop
ui-transport:
    {{storage}} node apps/desktop/scripts/generate-transport-types.mts
    # node-suite: frontend-full-3
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/transport-types.test.mts

ui-build:
    {{storage}} node scripts/run-viteplus.mts run frontend:build

ui-test:
    # node-suite: frontend-full-5
    {{storage}} node --test --test-reporter=./scripts/required-node-test-reporter.mts scripts/transport-values.test.mts
    {{storage}} node scripts/run-viteplus.mts run frontend:unit

fallow:
    # node-suite: fallow
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/check-fallow-report.test.mts scripts/run-fallow.test.mts scripts/fallow-summary.test.mts scripts/fallow-scope.test.mts scripts/fallow-source.test.mts
    {{storage}} node scripts/run-fallow.mts

# Selective advisory assistance; never an ordinary local/PR stage.
fallow-tooling:
    {{storage}} node scripts/run-fallow.mts tooling

fallow-review base reuse="":
    {{storage}} node scripts/run-fallow.mts review {{quote(base)}} {{quote(reuse)}}

fallow-css:
    {{storage}} node scripts/run-fallow.mts css

oxlint:
    {{storage}} node scripts/run-viteplus.mts lint

stylelint:
    {{storage}} node scripts/run-viteplus.mts -C apps/desktop run lint:style

ui-lint-contracts:
    {{storage}} node scripts/lint-tools.integration.mts oxfmt oxlint stylelint

ui-check:
    {{storage}} node scripts/run-fallow.mts
    {{storage}} node scripts/run-viteplus.mts run frontend:verify

ui-static:
    {{storage}} node scripts/run-viteplus.mts run frontend:static

ui-runtime:
    {{storage}} node scripts/run-viteplus.mts -C apps/desktop run browser:bootstrap
    {{storage}} node scripts/run-viteplus.mts run frontend:runtime

check-ui: ui-check ui-lint-contracts

# Cross-language scripts and hosted automation.
python-lint:
    {{storage}} aqua exec -- ruff check apps/desktop/assets/brand/models/v2

shell-lint:
    {{storage}} aqua exec -- shellcheck --severity=warning scripts/bootstrap-quality-tools.sh scripts/install-linux-desktop-prerequisites.sh scripts/test-linux-package-ownership.sh

actions-lint:
    {{storage}} node scripts/run-actionlint.mts

powershell-lint:
    {{storage}} node scripts/run-powershell-lint.mts

script-lint-contracts:
    {{storage}} node scripts/lint-tools.integration.mts ruff shellcheck actionlint psscriptanalyzer

script-lint: python-lint shell-lint actions-lint powershell-lint script-lint-contracts

# Offline drift check and publisher-verified repair for Aqua package checksums.
aqua-integrity-check:
    {{storage}} node scripts/aqua-integrity.mts --check

aqua-integrity-update:
    {{storage}} node scripts/aqua-integrity.mts --update

# Generic repository automation and governance contracts.
repository-tools:
    # node-suite: repository-tools
    {{storage}} node --test --test-concurrency=2 --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/upstream-observer.test.mts scripts/upstream-health-providers.test.mts scripts/upstream-health-planning.test.mts scripts/upstream-health-accounting.test.mts scripts/upstream-health-source-archives.test.mts scripts/upstream-health.test.mts scripts/upstream-health-plan.test.mts scripts/upstream-health-monitor.test.mts scripts/upstream-health-triage.test.mts
    # node-suite: repository-tools-2
    {{storage}} node --test --test-concurrency=2 --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/ci-workflow.test.mts scripts/ci-frontend-workflow.test.mts scripts/ci-release-workflow.test.mts scripts/ci-native-workflow.test.mts scripts/native-backup-evidence.test.mts scripts/ci-rust-workflow.test.mts scripts/rust-toolchain-reader.test.mts scripts/windows-rust-tests.test.mts scripts/rust-coverage.test.mts scripts/check-catalog-repositories.test.mts scripts/check-retcomm-upstreams.test.mts scripts/deep-audit-summary.test.mts scripts/node-test-inventory.test.mts scripts/ci-health.test.mts scripts/workflow-provenance.test.mts scripts/check-document-links.test.mts scripts/nextest-equivalence.test.mts scripts/ordinary-git-routing.test.mts scripts/package-ownership-selection.test.mts scripts/postmerge-ci.test.mts scripts/validation-plan.test.mts scripts/select-ci-plan.test.mts scripts/ci-result-gate.test.mts scripts/ci-baseline.test.mts scripts/ci-baseline-execution.test.mts scripts/qualification-coverage.test.mts scripts/release-result-gate.test.mts scripts/linux-beta-risk-706.test.mts scripts/linux-beta-risk-706-controller.test.mts scripts/dependency-security.test.mts scripts/desktop-input-observation.test.mts scripts/required-node-test-reporter.test.mts scripts/nextest-outcomes.test.mts scripts/qualification-nextest.test.mts scripts/test-duration-reporter.test.mts scripts/python-test-results.test.mts scripts/ui-test-selection.test.mts scripts/quality-tools.test.mts scripts/dependency-automation.test.mts scripts/pnpm-lock-inventory.test.mts scripts/frontend-build-compare.test.mts scripts/renovate-engine-probe.test.mts scripts/repository-settings.test.mts scripts/pr-conventions.test.mts scripts/pr-delivery.test.mts scripts/pr-delivery-snapshot.test.mts scripts/github-api.test.mts scripts/cleanup-intel-artifacts.test.mts scripts/dev-storage.test.mts scripts/generate-catalog.test.mts scripts/catalog-source-authoring.test.mts scripts/catalog-proposal-comparison.test.mts scripts/catalog-artwork-dispatch.test.mts scripts/catalog-artwork-batches.test.mts scripts/catalog-artwork-provider.test.mts scripts/catalog-artwork-lifecycle.test.mts scripts/catalog-artwork-backoff.test.mts scripts/upstream-lineage.test.mts scripts/prepare-port.test.mts scripts/maintainer-config.test.mts scripts/catalog-staged-check.test.mts scripts/catalog-proposal-costs.test.mts scripts/migrate-catalog-schema2.test.mts scripts/ci-job-timeout-probe.test.mts
    {{storage}} node scripts/qualification-coverage.mts
    {{storage}} node scripts/check-retcomm-upstreams.mts --offline
    {{storage}} node scripts/quality-tools.mts --validate
    {{storage}} node scripts/aqua-integrity.mts --check
    {{storage}} node scripts/repository-settings.mts --validate

# Deterministic release metadata, packaging, updater, and qualification unit contracts.
release-check:
    # node-suite: release-check
    {{storage}} node --test --experimental-test-module-mocks --test-timeout=60000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/check-release-metadata.test.mts scripts/release-package-policy.test.mts scripts/release-public-build-inputs.test.mts scripts/release-public-build-provenance.test.mts scripts/write-release-checksums.test.mts scripts/hosted-native-continuity.test.mts scripts/updater-artifact-inventory.test.mts scripts/reconcile-release-assets.test.mts scripts/trusted-release-assembly.test.mts scripts/release-artifact-archive.test.mts scripts/finalize-release-assets.test.mts scripts/generate-release-downloads.test.mts scripts/select-release-channel.test.mts scripts/controller-canary.test.mts scripts/production-controller-admission.test.mts scripts/release-job-authorities.test.mts scripts/release-site-composer.test.mts scripts/release-metadata-renewal.test.mts scripts/assembler-job-identity.test.mts scripts/release-control-inputs.test.mts scripts/release-capacity.test.mts scripts/release-coordinator-journal-api.test.mts scripts/release-semantic-review.test.mts scripts/release-semantic-broker.test.mts scripts/release-semantic-reader-core.test.mts scripts/semantic-review-linux-supervisor.test.mts scripts/trusted-aggregate-attestation.test.mts scripts/production-aggregate-steps.test.mts scripts/acquire-release-admission.test.mts scripts/release-source-changes.test.mts scripts/release-coordinator.test.mts scripts/release-coordinator-state.test.mts scripts/release-coordinator-recovery.test.mts scripts/release-coordinator-remote.test.mts scripts/release-coordinator-checkpoint-evidence.test.mts scripts/release-native-checkpoint-custody.test.mts scripts/release-coordinator-signing-custody.test.mts scripts/release-coordinator-native-deadline.test.mts scripts/release-checkpoint-store.test.mts scripts/release-coordinator-capacity-effects.test.mts scripts/release-coordinator-metadata.test.mts scripts/release-coordinator-signing-exchange.test.mts scripts/release-coordinator-owned-executor.test.mts scripts/release-coordinator-checkpoint-authentication.test.mts scripts/release-coordinator-checkpoint-signing.test.mts scripts/release-prepared-transport.test.mts scripts/release-preparation-source.test.mts scripts/release-coordinator-driver.test.mts scripts/release-review-request.test.mts scripts/release-candidate-dispatch.test.mts scripts/release-candidate-progress-contract.test.mts scripts/release-candidate-progress.test.mts scripts/release-run-evidence.test.mts scripts/reconstruct-application-update-records.test.mts scripts/release-workflow.test.mts scripts/sign-catalog.test.mts scripts/windows-qualification-session.test.mts scripts/qualification-preparation.test.mts scripts/release-live-control-admission.test.mts scripts/release-control-handshake.test.mts scripts/release-payload-signing.test.mts scripts/release-payload-preparation.test.mts scripts/release-handshake-hosted-fixture.test.mts scripts/release-site-readback.test.mts scripts/release-site-deployment.test.mts scripts/release-site-controller.test.mts scripts/release-control-step-bridge.test.mts scripts/release-pages-provider.test.mts scripts/release-capacity-executor.test.mts scripts/release-capacity-operation.test.mts scripts/release-catalog-metadata-contract.test.mts scripts/release-catalog-inspection.test.mts scripts/release-catalog-authorities.test.mts scripts/release-catalog-semantic.test.mts scripts/release-catalog-signing.test.mts scripts/release-catalog-source.test.mts scripts/release-catalog-review-request.test.mts scripts/release-catalog-review-maintenance.test.mts scripts/release-catalog-site-controller.test.mts scripts/release-catalog-recovery.test.mts scripts/release-catalog-continuation.test.mts scripts/release-catalog-context-boundary.test.mts scripts/release-controller-catalog-routing.test.mts scripts/release-catalog-coordinator.test.mts scripts/release-catalog-review-disposition.test.mts scripts/release-candidate-qualification.test.mts scripts/release-immutable-publication.test.mts scripts/release-controller-tools.test.mts scripts/release-role-key-channel.test.mts scripts/release-acceptance-evidence.test.mts scripts/release-compiler-capture.test.mts scripts/release-native-observation.test.mts scripts/release-compiler-outputs.test.mts scripts/release-compiler-source.test.mts scripts/release-compiler-source-admission.test.mts scripts/release-compiler-evidence.test.mts scripts/release-source-attestation.test.mts scripts/release-native-qualification-contract.test.mts scripts/release-published-source.test.mts scripts/release-semantic-disposition.test.mts scripts/release-semantic-disposition-reader.test.mts scripts/release-signing-handoff.test.mts scripts/release-native-acceptance.test.mts scripts/release-native-admission.test.mts scripts/release-classification-request.test.mts scripts/native-qualification-account.test.mts scripts/native-qualification-account-client.test.mts scripts/native-qualification-account-adapter.test.mts scripts/desktop-native-account-session.test.mts scripts/release-signing-context.test.mts scripts/release-preview-withdrawals.test.mts scripts/release-signing-context-artifact.test.mts scripts/release-publication-result.test.mts scripts/release-publication-result-artifact.test.mts scripts/release-controller-wake.test.mts scripts/release-coordinator-deadline.test.mts scripts/release-semantic-worker.test.mts scripts/release-semantic-source.test.mts scripts/release-tuf-signing.test.mts scripts/release-tuf-role-artifact.test.mts scripts/release-publication-controller.test.mts scripts/release-publication-inputs.test.mts scripts/release-publication-source.test.mts scripts/release-local-native-setup.test.mts scripts/release-local-worker-tasks.test.mts scripts/release-local-worker-accounts.test.mts scripts/release-native-account-capability.test.mts scripts/recover-local-worker-empty-setup.test.mts scripts/release-native-attempt.test.mts scripts/release-native-windows-driver.test.mts scripts/release-native-windows-public-continuation.test.mts scripts/release-native-source-contract.test.mts scripts/release-native-source-provider.test.mts scripts/release-native-pre-sign-report.test.mts scripts/release-native-check-broker.test.mts scripts/release-native-candidate.test.mts scripts/release-native-parent.test.mts scripts/native-linux-public-fuse.test.mts scripts/native-linux-public-plan.test.mts scripts/native-linux-public-services.test.mts scripts/release-native-linux-public-capture.test.mts scripts/release-native-public-pair.test.mts scripts/release-native-public-compiler.test.mts scripts/release-native-public-signature.test.mts scripts/release-native-public-attempt-contract.test.mts scripts/release-native-scheduler.test.mts scripts/release-native-stage-capture.test.mts scripts/release-hosted-native-acceptance.test.mts scripts/release-hosted-native-history.test.mts scripts/release-hosted-native-linux-capture.test.mts scripts/release-hosted-native-linux-report.test.mts scripts/release-hosted-native-proof-producer.test.mts scripts/release-hosted-native-job.test.mts scripts/release-hosted-native-runner.test.mts scripts/release-routing-marker.test.mts scripts/release-hosted-native-installation.test.mts scripts/release-pnpm-runtime.test.mts scripts/release-hosted-native-proof.test.mts scripts/release-pages-recovery.test.mts scripts/release-pages-metadata-recovery.test.mts scripts/release-tuf-controller.test.mts scripts/release-metadata-signing-context.test.mts scripts/release-metadata-context-recovery.test.mts scripts/release-run-artifact-inventory.test.mts scripts/release-metadata-site-controller.test.mts scripts/release-bootstrap-preparation.test.mts scripts/release-controller-transport.test.mts scripts/release-candidate-signing-recovery.test.mts scripts/release-production-dag.test.mts scripts/release-admitted-aggregate-controller.test.mts scripts/release-native-check-discovery.test.mts scripts/release-connected-fixture.test.mts scripts/release-native-wsl-boundary.test.mts scripts/native-linux-driver-http.test.mts scripts/native-linux-isolated-init.test.mts scripts/native-linux-isolated-plan.test.mts scripts/release-native-linux-driver.test.mts scripts/native-qualification-linux-supervisor.test.mts scripts/native-qualification-linux-transfer.test.mts scripts/release-native-wsl-capture.test.mts scripts/release-pending-release-recovery.test.mts scripts/release-pending-result-recovery.test.mts scripts/release-report-repair-contract.test.mts scripts/release-report-repair-identity.test.mts scripts/native-linux-public-network.test.mts scripts/release-native-presign-readiness.test.mts scripts/release-native-runtime-custody.test.mts
    {{storage}} node scripts/check-release-metadata.mts

# Stateful packaged-session qualification. Never reused by the audit orchestrator.
windows-qualification-check:
    node -e "if (process.platform !== 'win32') { console.error('windows-qualification-check requires Windows'); process.exit(1) }"
    pwsh -NoLogo -NoProfile -File scripts/run-windows-qualification.ps1

# Offline roadmap schema and governance checks. Live Project access is explicit.
roadmap-check:
    # node-suite: roadmap-check
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/roadmap.test.mts scripts/roadmap-execution.test.mts scripts/roadmap-intake.test.mts scripts/roadmap-views.test.mts scripts/roadmap-readiness.test.mts scripts/roadmap-mutations.test.mts scripts/roadmap-qualification.test.mts scripts/roadmap-provider-inventory.test.mts scripts/roadmap-scoped.test.mts scripts/roadmap-authoring.test.mts scripts/roadmap-report.test.mts scripts/roadmap-publish.test.mts scripts/roadmap-membership-readback.test.mts scripts/source-provenance-audit.test.mts scripts/discovery-checkpoint.test.mts scripts/daily-discovery-quiver.test.mts scripts/discovery-intake.test.mts scripts/roadmap-inventory.test.mts scripts/repository-issue-inventory.test.mts scripts/roadmap-rest-intake.test.mts scripts/daily-discovery.test.mts scripts/discovery-leads.test.mts scripts/discovery-ecosystems.test.mts scripts/discovery-reconciliation.test.mts
    {{storage}} node scripts/roadmap.mts check

roadmap-doctor:
    node scripts/roadmap.mts doctor

roadmap-next *args:
    node scripts/roadmap.mts next {{args}}

# Read-only live task context; historical consumption references remain comparable.
roadmap-context *args:
    node scripts/roadmap.mts context {{args}}

roadmap-bootstrap:
    node scripts/roadmap.mts bootstrap

# Standard repository check. Packaged release qualification is intentionally separate.
check: check-rust check-ui script-lint repository-tools roadmap-check development-tools

# Development regression policy; preserves the raw scanner result separately
security:
    {{storage}} node scripts/dependency-security.mts

# Raw dependency scanner (known GLib finding exits 1)
deny:
    {{storage}} node scripts/dependency-security.mts scan

cycles:
    -{{storage}} cargo modules dependencies -p portcove-core --lib --acyclic

rscheck:
    # node-suite: rust-quality-full-3
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/run-rscheck.test.mts
    {{storage}} node scripts/run-rscheck.mts

audit *args:
    {{storage}} node scripts/audit.mts {{args}}

mutants:
    {{storage}} node scripts/run-rust-tests.mts --guard-command cargo mutants --package portcove-core

# Explicit Windows Core path investigation; no ordinary-check dependency or downloads.
rust-coverage:
    {{storage}} node scripts/rust-coverage.mts

# Read-only hosted CI history; kept outside required offline checks.
ci-health:
    node scripts/ci-health.mts
