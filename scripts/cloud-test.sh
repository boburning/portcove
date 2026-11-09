#!/usr/bin/env bash
# Run one validation command in a disposable Linux cloud container as the
# unprivileged identity that scripts/bootstrap-cloud-session.sh creates.
set -euo pipefail

if [[ "${1:-}" == --help || "${1:-}" == -h || $# -eq 0 ]]; then
  cat <<'HELP'
Usage: bash scripts/cloud-test.sh COMMAND [ARGUMENT...]

Run COMMAND from the checkout as the ordinary portcove-test user with a minimal
environment. Release and native fixtures intentionally refuse root and Node
processes that trust an egress proxy's injected CA settings, and a global
commit-signing configuration changes fixture commit bytes. This wrapper removes
those cloud-only differences without changing any fixture or policy.

Run as root after the bootstrap's test-user step. Commands needing the network
still go through the inherited proxy variables, but Node then uses its bundled
CA store and refuses a TLS-inspecting proxy; run networked work directly instead.

Example:
  bash scripts/cloud-test.sh node --test scripts/release-native-wsl-capture.test.mts
HELP
  [[ $# -eq 0 ]] && exit 2
  exit 0
fi

user=portcove-test
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(id -u)" != 0 ]] || ! id "$user" >/dev/null 2>&1; then
  printf 'Run as root after bash scripts/bootstrap-cloud-session.sh created %s.\n' "$user" >&2
  exit 1
fi
home="/home/$user"
runuser -u "$user" -- mkdir -p "$home/temp" "$home/outputs" "$home/.cargo"
exec runuser -u "$user" -- env -i \
  PATH="$PATH" HOME="$home" LANG=C.UTF-8 TERM="${TERM:-dumb}" \
  RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" CARGO_HOME="$home/.cargo" \
  PORTCOVE_TEMP_DIR="$home/temp" PORTCOVE_OUTPUT_DIR="$home/outputs" \
  bash -c 'cd "$1" && shift && exec "$@"' cloud-test "$project_root" "$@"
