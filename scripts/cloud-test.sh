#!/usr/bin/env bash
# Run one offline validation command in a disposable Linux cloud container as
# the unprivileged identity that scripts/bootstrap-cloud-session.sh creates.
set -euo pipefail

if [[ "${1:-}" == --help || "${1:-}" == -h || $# -eq 0 ]]; then
  cat <<'HELP'
Usage: bash scripts/cloud-test.sh COMMAND [ARGUMENT...]

Refresh a private copy of this working tree owned by the ordinary portcove-test
user, then run COMMAND there as that user with a minimal environment. Release
and native fixtures intentionally refuse root, Node processes that trust an
egress proxy's injected CA settings, inputs that another user can write, and
fixture commits changed by a global commit-signing configuration. The copy and
environment remove those cloud-only differences without changing any fixture
or policy.

The command has no network access: no proxy or credential variables are passed.
Use it for offline Node and repository-tool suites, including fixtures that
run offline cargo commands with the toolchain the bootstrap shares read-only
under /opt/portcove-rust, and `corepack pnpm` with the pnpm it pre-fetched.
Run builds and networked commands directly. Installed dependencies are copied once per lockfile
and the browser cache is shared read-only; other ignored outputs are not copied.

Example:
  bash scripts/cloud-test.sh node --test scripts/release-native-wsl-capture.test.mts
HELP
  [[ $# -eq 0 ]] && exit 2
  exit 0
fi

user=portcove-test
home=/home/portcove-test
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(id -u)" != 0 ]] || ! id "$user" >/dev/null 2>&1; then
  printf 'Run as root after bash scripts/bootstrap-cloud-session.sh created %s.\n' "$user" >&2
  exit 1
fi

# A fresh owned copy each run keeps uncommitted work and never leaves stale
# files. Installed dependencies are copied, not linked, because fixed-tool
# fixtures refuse packages outside their checkout; that copy is reused until the
# lockfile or package manifests change.
deps=(node_modules apps/desktop/node_modules)
stamp="$(cat "$project_root/pnpm-lock.yaml" "$project_root/package.json" \
  "$project_root/apps/desktop/package.json" | sha256sum | cut -c1-64)"
mirror=/home/portcove-test/portcove
stash=/home/portcove-test/dependencies
rm -rf -- /home/portcove-test/dependencies
if [[ -f "$home/.cloud-test-dependencies" && "$(cat "$home/.cloud-test-dependencies")" == "$stamp" ]]; then
  for shared in "${deps[@]}"; do
    [[ ! -d "$mirror/$shared" ]] || { mkdir -p "$(dirname "$stash/$shared")"; mv "$mirror/$shared" "$stash/$shared"; }
  done
fi
rm -rf -- /home/portcove-test/portcove
mkdir -p "$mirror"
tar -C "$project_root" \
  --exclude=./node_modules --exclude=./apps/desktop/node_modules --exclude=./apps/desktop/dist \
  --exclude=./apps/desktop/src-tauri/gen --exclude=./target --exclude=./target.portcove-rust-support \
  --exclude=./work --exclude=./outputs -cf - . | tar -C "$mirror" -xf -
chown -R "$user:" "$mirror"
for shared in "${deps[@]}"; do
  if [[ -d "$stash/$shared" ]]; then
    mv "$stash/$shared" "$mirror/$shared"
  elif [[ -d "$project_root/$shared" ]]; then
    tar -C "$project_root" -cf - "$shared" | tar -C "$mirror" -xf -
    chown -R "$user:" "$mirror/$shared"
  fi
done
printf '%s\n' "$stamp" > "$home/.cloud-test-dependencies"
rm -rf -- /home/portcove-test/dependencies

# Scratch stays outside the copy so isolated "no installed packages" fixtures
# cannot resolve the copy's node_modules through a parent directory.
runuser -u "$user" -- mkdir -p "$home/temp" "$home/outputs"
# The shared toolchain is read-only to this identity; Cargo's own cache stays in
# its home.
rust=/opt/portcove-rust
test_path="$PATH"
rust_env=()
if [[ -d "$rust/rustup" && -d "$rust/cargo-bin" ]]; then
  test_path="$rust/cargo-bin:$PATH"
  rust_env=(RUSTUP_HOME="$rust/rustup" CARGO_HOME="$home/.cargo")
fi
exec runuser -u "$user" -- env -i \
  PATH="$test_path" HOME="$home" LANG=C.UTF-8 TERM="${TERM:-dumb}" "${rust_env[@]}" \
  PLAYWRIGHT_BROWSERS_PATH="$project_root/work/browser-cache" \
  PORTCOVE_TEMP_DIR="$home/temp" PORTCOVE_OUTPUT_DIR="$home/outputs" \
  bash -c 'cd "$1" && shift && exec "$@"' cloud-test "$home/portcove" "$@"
