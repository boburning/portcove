set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

default: check

# Rust fast loop
fmt:
    cargo fmt --all -- --check

rust-check:
    cargo check --workspace --all-targets

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

rust-test:
    cargo test --workspace

shear:
    cargo shear --deny-warnings

architecture:
    node --test scripts/check-rust-architecture.test.mjs
    node scripts/check-rust-architecture.mjs

check-rust: fmt rust-check clippy rust-test shear architecture

# Frontend fast loop
ui-build:
    pnpm --dir apps/desktop build

ui-test:
    pnpm --dir apps/desktop test

fallow:
    node --test scripts/check-fallow-report.test.mjs
    node scripts/run-fallow.mjs

check-ui: ui-build ui-test fallow

# Deterministic release metadata and artifact tooling
release-tools:
    node --test scripts/check-release-metadata.test.mjs scripts/write-release-checksums.test.mjs
    node scripts/check-release-metadata.mjs

# Standard repository check
check: check-rust check-ui release-tools

# Deeper deterministic and structural audit
deny:
    cargo deny check --hide-inclusion-graph -W unmaintained

cycles:
    -cargo modules dependencies -p portcove-core --lib --acyclic

rscheck:
    node --test scripts/run-rscheck.test.mjs
    node scripts/run-rscheck.mjs

audit: check deny cycles rscheck

# Expensive or experimental intelligence. Failures remain diagnostic.
hawk:
    node scripts/run-hawk.mjs

duplicates:
    node scripts/run-semdup.mjs

deep: audit hawk duplicates

mutants:
    cargo mutants --package portcove-core
