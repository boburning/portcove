set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

storage := "node scripts/dev-storage.mjs run --"

default: check

preflight:
    node scripts/dev-storage.mjs preflight

doctor:
    node scripts/dev-doctor.mjs

# Advisory pull request metadata check; requires GitHub authentication.
pr-check *args:
    node scripts/pr-conventions.mjs --pr {{args}}

development-tools:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/dev-doctor.test.mjs scripts/development-evidence.test.mjs scripts/native-session.test.mjs

desktop-test *args:
    {{storage}} node apps/desktop/scripts/desktop-test.mjs {{args}}

# Windows external-reference client; requires Visual Studio Build Tools.
playnite-check *args:
    pwsh -NoProfile -File integrations/playnite/check.ps1 {{args}}

clean-build:
    node scripts/dev-storage.mjs clean

# Repository formatting
fmt:
    {{storage}} cargo fmt --all
    {{storage}} pnpm --dir apps/desktop format

fmt-check:
    {{storage}} cargo fmt --all -- --check
    {{storage}} pnpm --dir apps/desktop format:check

# Rust fast loop
rustfmt-check:
    {{storage}} cargo fmt --all -- --check

rust-check:
    {{storage}} cargo check --workspace --all-targets

clippy:
    {{storage}} cargo clippy --workspace --all-targets -- -D warnings

rust-test:
    {{storage}} node scripts/run-rust-tests.mjs --locked --workspace
    {{storage}} cargo test --locked --workspace --doc

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

check-rust: rustfmt-check rust-check clippy rust-test shear architecture process-policy transport-contract

# Frontend fast loop
ui-transport:
    {{storage}} node apps/desktop/scripts/generate-transport-types.mjs
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/transport-types.test.mjs

ui-build:
    {{storage}} pnpm --dir apps/desktop build

ui-test:
    {{storage}} pnpm --dir apps/desktop test

fallow:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-fallow-report.test.mjs
    {{storage}} node scripts/run-fallow.mjs

eslint:
    {{storage}} corepack pnpm --dir apps/desktop lint:eslint
    {{storage}} node scripts/lint-tools.integration.mjs eslint

stylelint:
    {{storage}} corepack pnpm --dir apps/desktop lint:style
    {{storage}} node scripts/lint-tools.integration.mjs stylelint

check-ui: fmt-frontend-check ui-transport ui-build ui-test fallow eslint stylelint

fmt-frontend-check:
    {{storage}} pnpm --dir apps/desktop format:check

# Cross-language scripts and hosted automation.
python-lint:
    {{storage}} node scripts/quality-tools.mjs --run ruff -- check apps/desktop/assets/brand/models/v2
    {{storage}} node scripts/lint-tools.integration.mjs ruff

shell-lint:
    {{storage}} node scripts/quality-tools.mjs --run shellcheck -- --severity=warning scripts/bootstrap-quality-tools.sh
    {{storage}} node scripts/lint-tools.integration.mjs shellcheck

actions-lint:
    {{storage}} node scripts/quality-tools.mjs --run actionlint --
    {{storage}} node scripts/lint-tools.integration.mjs actionlint

powershell-lint:
    {{storage}} node scripts/run-powershell-lint.mjs
    {{storage}} node scripts/lint-tools.integration.mjs psscriptanalyzer

script-lint: python-lint shell-lint actions-lint powershell-lint

# Deterministic release metadata and artifact tooling
release-tools:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/upstream-observer.test.mjs
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/check-release-metadata.test.mjs scripts/release-package-policy.test.mjs scripts/write-release-checksums.test.mjs scripts/updater-artifact-inventory.test.mjs scripts/reconcile-release-assets.test.mjs scripts/generate-release-downloads.test.mjs scripts/select-release-channel.test.mjs scripts/release-workflow.test.mjs scripts/ci-workflow.test.mjs scripts/ci-health.test.mjs scripts/test-duration-reporter.test.mjs scripts/quality-tools.test.mjs scripts/repository-settings.test.mjs scripts/pr-conventions.test.mjs scripts/dev-storage.test.mjs scripts/migrate-catalog-schema2.test.mjs scripts/windows-qualification-session.test.mjs
    {{storage}} node --test scripts/windows-qualification-session.integration.test.mjs
    {{storage}} node scripts/check-release-metadata.mjs
    {{storage}} node scripts/check-retcomm-upstreams.mjs --offline
    {{storage}} node scripts/quality-tools.mjs --validate
    {{storage}} node scripts/repository-settings.mjs --validate

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

# Standard repository check
check: check-rust check-ui script-lint release-tools roadmap-check development-tools

# Deeper deterministic and structural audit
deny:
    {{storage}} cargo deny check --hide-inclusion-graph -W unmaintained

cycles:
    -{{storage}} cargo modules dependencies -p portcove-core --lib --acyclic

rscheck:
    {{storage}} node --test --test-timeout=30000 --test-reporter=./scripts/test-duration-reporter.mjs scripts/run-rscheck.test.mjs
    {{storage}} node scripts/run-rscheck.mjs

audit: check deny rscheck

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
