set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

storage := "node scripts/dev-storage.mjs run --"

# The no-argument developer loop is the complete diff-selected local plan.
default: local-check

preflight:
    node scripts/dev-storage.mjs preflight

doctor *args:
    node scripts/dev-doctor.mjs {{args}}

# Advisory pull request metadata check; requires GitHub authentication.
pr-check *args:
    node scripts/pr-conventions.mjs --pr {{args}}

# Exact-head REST observation and guarded normal merge for a qualified pull request.
pr-watch *args:
    node scripts/pr-delivery.mjs watch {{args}}

pr-merge-rest *args:
    node scripts/pr-delivery.mjs merge {{args}}

development-tools:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/audit.test.mjs scripts/desktop-build-cache.test.mjs scripts/desktop-scenarios.test.mjs scripts/desktop-verify.test.mjs scripts/dev-doctor.test.mjs scripts/development-cli-help.test.mjs scripts/development-evidence.test.mjs scripts/heavy-rust-test-lock.test.mjs scripts/local-validation.test.mjs scripts/native-session-lock.test.mjs scripts/native-session.test.mjs scripts/process-lock.test.mjs scripts/repository-skills.test.mjs scripts/run-rust-tests.test.mjs scripts/rust-test-impact.test.mjs scripts/rust-test-tree-supervisor.test.mjs scripts/tool-cache.test.mjs

# Complete selected local loop; required hosted CI runs its separately selected plan.
local-check *args:
    {{storage}} node scripts/local-validation.mjs check {{args}}

test-rust *args:
    {{storage}} node scripts/local-validation.mjs test-rust {{args}}

test-ui-related *args:
    {{storage}} node scripts/local-validation.mjs test-ui-related {{args}}

test-node *args:
    {{storage}} node scripts/local-validation.mjs test-node {{args}}

desktop-test *args:
    {{storage}} node scripts/desktop-test-cli.mjs {{args}}

# Build, isolate, select, and retain native desktop verification evidence.
desktop-verify *args:
    {{storage}} node scripts/desktop-verify.mjs {{args}}

# Windows external-reference client; requires Visual Studio Build Tools.
playnite-check *args:
    pwsh -NoProfile -File integrations/playnite/check.ps1 {{args}}

clean-build:
    node scripts/dev-storage.mjs clean

# Explicit storage recovery; ordinary validation preserves incremental reuse.
prune-incremental:
    node scripts/dev-storage.mjs prune-incremental

# Repository formatting
fmt:
    {{storage}} cargo fmt --all
    {{storage}} corepack pnpm --dir apps/desktop format

fmt-check:
    {{storage}} cargo fmt --all -- --check
    {{storage}} corepack pnpm --dir apps/desktop format:check

# Rust fast loop
rustfmt-check:
    {{storage}} cargo fmt --all -- --check

rust-check:
    {{storage}} node scripts/run-rust-tests.mjs --guard-command cargo check --workspace --all-targets

clippy:
    {{storage}} node scripts/run-rust-tests.mjs --guard-command cargo clippy --workspace --all-targets -- -D warnings

rust-test:
    {{storage}} node scripts/run-rust-tests.mjs --locked --workspace
    {{storage}} node scripts/run-rust-tests.mjs --guard-command cargo test --locked --workspace --doc

shear:
    {{storage}} cargo shear --deny-warnings

architecture:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-rust-architecture.test.mjs
    {{storage}} node scripts/check-rust-architecture.mjs

process-policy:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-child-process-policy.test.mjs
    {{storage}} node scripts/check-child-process-policy.mjs

transport-contract:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-transport-contract.test.mjs
    {{storage}} node scripts/check-transport-contract.mjs
    {{storage}} node --test scripts/check-transport-contract.integration.test.mjs

check-rust: rustfmt-check clippy rust-test shear architecture process-policy transport-contract

# Frontend fast loop
ui-transport:
    {{storage}} node apps/desktop/scripts/generate-transport-types.mjs
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/transport-types.test.mjs

ui-build:
    {{storage}} corepack pnpm --dir apps/desktop build

ui-test:
    {{storage}} corepack pnpm --dir apps/desktop test

fallow:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-fallow-report.test.mjs
    {{storage}} node scripts/run-fallow.mjs

oxlint:
    {{storage}} corepack pnpm --dir apps/desktop lint:oxlint

stylelint:
    {{storage}} corepack pnpm --dir apps/desktop lint:style

ui-lint-contracts:
    {{storage}} node scripts/lint-tools.integration.mjs oxfmt oxlint stylelint

ui-check: ui-transport ui-build ui-test fallow oxlint stylelint

check-ui: fmt-frontend-check ui-check ui-lint-contracts

fmt-frontend-check:
    {{storage}} corepack pnpm --dir apps/desktop format:check

# Cross-language scripts and hosted automation.
python-lint:
    {{storage}} aqua exec -- ruff check apps/desktop/assets/brand/models/v2

shell-lint:
    {{storage}} aqua exec -- shellcheck --severity=warning scripts/bootstrap-quality-tools.sh scripts/install-linux-desktop-prerequisites.sh scripts/test-linux-package-ownership.sh

actions-lint:
    {{storage}} node scripts/run-actionlint.mjs

powershell-lint:
    {{storage}} node scripts/run-powershell-lint.mjs

script-lint-contracts:
    {{storage}} node scripts/lint-tools.integration.mjs ruff shellcheck actionlint psscriptanalyzer

script-lint: python-lint shell-lint actions-lint powershell-lint script-lint-contracts

# Offline drift check and publisher-verified repair for Aqua package checksums.
aqua-integrity-check:
    {{storage}} node scripts/aqua-integrity.mjs --check

aqua-integrity-update:
    {{storage}} node scripts/aqua-integrity.mjs --update

# Generic repository automation and governance contracts.
repository-tools:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/upstream-observer.test.mjs
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/ci-workflow.test.mjs scripts/ci-health.test.mjs scripts/workflow-provenance.test.mjs scripts/validation-plan.test.mjs scripts/select-ci-plan.test.mjs scripts/ci-result-gate.test.mjs scripts/qualification-coverage.test.mjs scripts/select-fast-host.test.mjs scripts/release-result-gate.test.mjs scripts/test-duration-reporter.test.mjs scripts/quality-tools.test.mjs scripts/dependency-automation.test.mjs scripts/repository-settings.test.mjs scripts/pr-conventions.test.mjs scripts/pr-delivery.test.mjs scripts/github-api.test.mjs scripts/dev-storage.test.mjs scripts/migrate-catalog-schema2.test.mjs
    {{storage}} node scripts/qualification-coverage.mjs
    {{storage}} node scripts/select-fast-host.mjs
    {{storage}} node scripts/check-retcomm-upstreams.mjs --offline
    {{storage}} node scripts/quality-tools.mjs --validate
    {{storage}} node scripts/aqua-integrity.mjs --check
    {{storage}} node scripts/repository-settings.mjs --validate

# Deterministic release metadata, packaging, updater, and qualification unit contracts.
release-check:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-release-metadata.test.mjs scripts/release-package-policy.test.mjs scripts/write-release-checksums.test.mjs scripts/updater-artifact-inventory.test.mjs scripts/reconcile-release-assets.test.mjs scripts/finalize-release-assets.test.mjs scripts/generate-release-downloads.test.mjs scripts/select-release-channel.test.mjs scripts/release-coordinator.test.mjs scripts/reconstruct-application-update-records.test.mjs scripts/release-workflow.test.mjs scripts/windows-qualification-session.test.mjs
    {{storage}} node scripts/check-release-metadata.mjs

# Stateful packaged-session qualification. Never reused by the audit orchestrator.
windows-qualification-check:
    node -e "if (process.platform !== 'win32') { console.error('windows-qualification-check requires Windows'); process.exit(1) }"
    pwsh -NoLogo -NoProfile -File scripts/run-windows-qualification.ps1

# Offline roadmap schema and governance checks. Live Project access is explicit.
roadmap-check:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/roadmap.test.mjs scripts/source-provenance-audit.test.mjs
    {{storage}} node scripts/roadmap.mjs check

roadmap-doctor:
    node scripts/roadmap.mjs doctor

roadmap-next:
    node scripts/roadmap.mjs next

roadmap-bootstrap:
    node scripts/roadmap.mjs bootstrap

# Standard repository check. Packaged release qualification is intentionally separate.
check: check-rust check-ui script-lint repository-tools roadmap-check development-tools

# Deeper deterministic and structural audit
deny:
    {{storage}} cargo deny check --hide-inclusion-graph -W unmaintained

cycles:
    -{{storage}} cargo modules dependencies -p portcove-core --lib --acyclic

rscheck:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/run-rscheck.test.mjs
    {{storage}} node scripts/run-rscheck.mjs

audit *args:
    {{storage}} node scripts/audit.mjs {{args}}

# Expensive or experimental intelligence. Failures remain diagnostic.
hawk:
    {{storage}} node scripts/run-hawk.mjs

duplicates:
    {{storage}} node scripts/run-semdup.mjs

deep: audit hawk duplicates

mutants:
    {{storage}} cargo mutants --package portcove-core

# Read-only hosted CI history; kept outside required offline checks.
ci-health:
    node scripts/ci-health.mjs
