# Archive extraction fuzzing

Opt-in coverage-guided fuzzing of the download archive readers for
[#5032](https://github.com/boburning/portcove/issues/5032). It is not an
ordinary check, a CI job or a merge prerequisite, and it runs only on Linux.

## Scope

Each target sends the input through `extract_download_archive_with_checkpoint`,
the production download extraction, so the input reaches the same reader,
extraction limits, path containment, link handling, integrity checks and
checkpoints as a real download asset.

| Target           | Reader reached by the asset extension          | Seeds                                    |
| ---------------- | ---------------------------------------------- | ---------------------------------------- |
| `archive_zip`    | ZIP (`zip` crate through `zip_read`)           | `tree.zip`, `alias.zip`                  |
| `archive_7z`     | 7z (`sevenz-turbo` with Portcove's limits)     | `tree.7z`                                |
| `archive_tar_gz` | TAR.GZ (`flate2` and `tar`, raw TAR preflight) | `tree.tar.gz`                            |
| `archive_tar_xz` | TAR.XZ (`lzma-turbo` verified blocks, `tar`)   | `tree.tar.xz`, `upstream-fixture.tar.xz` |

PSX/disc images, source inspection, catalog and TUF metadata and the other
parsers are outside this harness.

The entry (`portcove_core::archive_fuzzing`, compiled only with Core's
`archive-fuzzing` feature) writes each input to a new directory under
`std::env::temp_dir()`, extracts it there and removes the directory. A
refusal is ordinary. A finding is a panic, a crash, a libFuzzer timeout or
memory-limit failure, or a broken extraction contract, which the entry checks
after every success and every refusal:

- nothing is written beside the destination;
- the destination holds only regular files and directories;
- every written path passes the archive path rules;
- the written files stay within the entry, total-size and compression-ratio limits.

## Seeds

The seeds are small deterministic archives of one directory, a text file and an
executable launcher. `alias.zip` adds a ZIP link to a file in the same archive,
and `upstream-fixture.tar.xz` is the existing TAR.XZ test fixture. The Core test
`archive::fuzz_seed_tests` embeds every seed and requires each to extract
through the same entry, which shows the seeds reach their reader. To regenerate
them on Linux x86_64:

```sh
PORTCOVE_WRITE_ARCHIVE_FUZZ_SEEDS=1 cargo test --locked -p portcove-core --lib archive::fuzz_seed_tests
```

That run rewrites the files and then fails on purpose; run it again without the
variable to check the new bytes.

## Toolchain and dependencies

- `cargo-fuzz` is the `deep` tool pinned in `.github/quality-tools.json`. Install it with
  `cargo install cargo-fuzz --version =<pin> --locked`.
- The build needs a nightly compiler for the sanitizer flags. Use the dated
  `nightly-2026-09-02`, the same nightly the coverage investigation pins in
  `.config/rust-coverage.json`.
- This directory is its own Cargo workspace, excluded from the root workspace.
  `Cargo.lock` here is committed. It was seeded from the root lockfile, so every
  shared package has the version main resolves, and adds only `libfuzzer-sys`,
  `arbitrary` and this package. Production builds never see this lockfile, the
  `archive-fuzzing` feature or the nightly compiler.

## Build

Run from the repository root through the
[heavyweight Rust guard](../../../docs/DEVELOPMENT-TOOLS.md#shared-local-resources):

```sh
cargo fetch --locked --manifest-path crates/portcove-core/fuzz/Cargo.toml
node scripts/dev-storage.mts run -- node scripts/run-rust-tests.mts --guard-command \
  env CARGO_NET_OFFLINE=true \
  cargo +nightly-2026-09-02 fuzz build --fuzz-dir crates/portcove-core/fuzz
git diff --exit-code -- crates/portcove-core/fuzz/Cargo.lock
```

cargo-fuzz 0.13.2 has no `--locked` option and does not pass one to the
`cargo build` it runs, and Cargo has no configuration key for it. So the build
itself is **not** a locked build. The three commands instead:

1. fail before building if the committed lock does not satisfy the manifests,
   because `cargo fetch --locked` refuses any lock change, and download exactly
   the locked packages;
2. build with the normal cargo-fuzz instrumentation (AddressSanitizer by
   default) while offline, so the build cannot fetch anything new;
3. fail afterwards if the build changed the committed lock.

A plain `cargo build --locked` of this manifest would not be equivalent: it
would produce uninstrumented binaries.

## Campaign

Use a fresh corpus copy and a controlled temporary directory, for example:

```sh
mkdir -p work/archive-fuzz/{corpus,artifacts,tmp}
cp -r crates/portcove-core/fuzz/seeds/archive_zip work/archive-fuzz/corpus/
TMPDIR=$PWD/work/archive-fuzz/tmp node scripts/dev-storage.mts run -- \
  node scripts/run-rust-tests.mts --guard-command \
  cargo +nightly-2026-09-02 fuzz run --fuzz-dir crates/portcove-core/fuzz archive_zip \
  work/archive-fuzz/corpus/archive_zip -- \
  -max_total_time=600 -max_len=65536 -rss_limit_mb=2048 -timeout=20 \
  -artifact_prefix=work/archive-fuzz/artifacts/
```

Choose budgets that fit the shared host. With a 64 KiB input limit, the
compression-ratio limit bounds one input's output to about 12.5 MiB. The
`TMPDIR` directory should be empty after a clean run.

A clean bounded campaign does not show that every input is safe, and it says
nothing about other parsers or other platforms.

## Findings

Reproduce one with `cargo +nightly-2026-09-02 fuzz run --fuzz-dir
crates/portcove-core/fuzz <target> <artifact>` and minimize it with `fuzz tmin`.
Report a crash with security impact through the private route in
[SECURITY.md](../../../SECURITY.md) before publishing its input. Otherwise fix
the defect and add a focused deterministic regression in Core rather than
committing raw crash artifacts.
