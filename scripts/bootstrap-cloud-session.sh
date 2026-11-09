#!/usr/bin/env bash
# Provision an ephemeral Linux x86_64 cloud agent container from the checkout's
# canonical pins. Every version comes from a Renovate-managed repository file, so
# an environment setup script only calls this file and never carries its own pins.
set -euo pipefail

# Known cloud limit: Ruff and actionlint require GitHub artifact attestation from
# their upstream repositories, which a session scoped to this repository cannot
# read. Succeed only when every error-level line of an Aqua log belongs to that
# exact refusal for those two packages; any other error keeps the step failed.
aqua_failure_is_attestation_only() {
  local log=$1 line seen=false tools='(astral-sh/ruff|rhysd/actionlint)'
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(sed -E 's/\x1b\[[0-9;]*m//g' <<<"$line")"
    if [[ "$line" =~ (^|[[:space:]])ERR[[:space:]] || "$line" =~ level=error || "$line" =~ ^[[:space:]]*[Ee]rror[[:space:]:] ]]; then
      if [[ "$line" =~ ERR[[:space:]]install\ the\ package[[:space:]].*package_name=${tools}[[:space:]].*GitHub\ Artifact\ Attestations ]]; then
        seen=true
      elif [[ "$line" =~ ERR[[:space:]]aqua\ failed[[:space:]].*error=\"install\ packages:\ it\ failed\ to\ install\ some\ packages\" ]]; then
        :
      elif [[ "$line" =~ ^[[:space:]]*Error:\ HTTP\ 403:.*https://api\.github\.com/repos/${tools}/attestations/ ]]; then
        :
      elif [[ "$line" =~ ^[[:space:]]*error\ creating\ Sigstore\ verifier: ]]; then
        :
      else
        return 1
      fi
    fi
  done < "$log"
  $seen
}

# Sourcing defines the helper above without running host setup.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi

usage() {
  cat <<'HELP'
Usage: bash scripts/bootstrap-cloud-session.sh [--skip-browser] [--skip-desktop] [--help]

Provision a disposable Linux x86_64 cloud session for Portcove development:

  node       .node-version, verified against the official SHASUMS256.txt
  pnpm       package.json packageManager, then a frozen install and hooks
  resources  first-use coordinated admission for a never-used resource domain
  rust       rust-toolchain.toml through rustup
  prebuilt-tools
             .github/quality-tools.json prebuilt tools, verified against the
             install-action manifests at the digest CI reviews
  source-tools
             remaining required tools through their existing verified installers
  aqua       .config/tool-bootstrap.json, then the existing quality bootstrap
  browser    the pinned Playwright Chromium shell (needs the Playwright CDN)
  desktop    Linux desktop build prerequisites through apt
  powershell tools/containers/build/Dockerfile PowerShell version and SHA-256
  history    complete Git history when the clone is shallow
  test-user  an unprivileged identity and resource domain for scripts/cloud-test.sh

Existing exact versions are reused. A failed step is reported and the
remaining steps continue; the exit status is 1 when any step failed. An
environment setup script should report that status without stopping session
start, for example: bash scripts/bootstrap-cloud-session.sh || echo incomplete
Use only on a disposable container: it installs system packages and writes
links into the directory that currently provides node, or /usr/local/bin.
HELP
}

skip_browser=false
skip_desktop=false
for option in "$@"; do
  case "$option" in
    --help|-h) usage; exit 0 ;;
    --skip-browser) skip_browser=true ;;
    --skip-desktop) skip_desktop=true ;;
    *) printf 'Unknown option: %s. Run with --help for the supported options.\n' "$option" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -sm)" != 'Linux x86_64' ]]; then
  printf 'Cloud bootstrap supports Linux x86_64 only; use scripts/bootstrap-quality-tools.sh or .ps1.\n' >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
failures=()

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --connect-timeout 20 \
    --max-time 600 --retry 2 --output "$2" "$1"
}

link_dir() {
  local current
  current="$(command -v node 2>/dev/null || true)"
  if [[ -n "$current" && -w "$(dirname "$current")" ]] &&
    [[ ! "$(dirname "$current")" =~ ^(/usr)?/s?bin$ ]]; then
    dirname "$current"
  else
    printf '/usr/local/bin\n'
  fi
}

step() {
  local name=$1 status
  shift
  printf '\n== %s\n' "$name"
  # A condition context disables errexit inside the called function, so run
  # each step as an ordinary subshell command and record its status.
  set +e
  (set -e; "$@")
  status=$?
  set -e
  if (( status == 0 )); then
    printf '%s: ready\n' "$name"
  else
    printf '%s: FAILED (exit %s)\n' "$name" "$status" >&2
    failures+=("$name")
  fi
}

install_node() {
  local pin archive destination bin
  pin="$(tr -d '\r\n' < .node-version)"
  [[ "$pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Malformed .node-version\n' >&2; return 1; }
  if [[ "$(node --version 2>/dev/null || true)" == "v$pin" ]]; then return 0; fi
  archive="node-v$pin-linux-x64.tar.xz"
  fetch "https://nodejs.org/dist/v$pin/$archive" "$scratch/$archive"
  fetch "https://nodejs.org/dist/v$pin/SHASUMS256.txt" "$scratch/SHASUMS256.txt"
  grep -E "^[0-9a-f]{64}  $archive\$" "$scratch/SHASUMS256.txt" > "$scratch/node.sha256"
  [[ "$(wc -l < "$scratch/node.sha256")" -eq 1 ]]
  (cd "$scratch" && sha256sum --check --status node.sha256)
  destination="/opt/portcove-node/v$pin"
  mkdir -p "$destination"
  tar -xJf "$scratch/$archive" -C "$destination" --strip-components=1
  bin="$(link_dir)"
  for tool in node npm npx corepack; do ln -sfn "$destination/bin/$tool" "$bin/$tool"; done
  hash -r
  [[ "$(node --version)" == "v$pin" ]]
}

install_frontend() {
  local spec
  spec="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json","utf8")).packageManager')"
  [[ "$spec" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Malformed packageManager\n' >&2; return 1; }
  if [[ "$(pnpm --version 2>/dev/null || true)" != "${spec#pnpm@}" ]]; then
    # npm's global prefix follows the real node path, which may not be on PATH.
    local prefix="/opt/portcove-pnpm/${spec#pnpm@}"
    npm install --global --prefix "$prefix" "$spec"
    for tool in pnpm pnpx; do ln -sfn "$prefix/bin/$tool" "$(link_dir)/$tool"; done
    hash -r
  fi
  [[ "$(pnpm --version)" == "${spec#pnpm@}" ]]
  node scripts/dev-storage.mts run -- pnpm install --frozen-lockfile
  node scripts/hooks-install.mts enable
}

# A container's resource domain starts empty. The existing owner-authorized
# cutover verifies that no legacy work holds it before selecting coordinated
# admission; an existing configuration is never changed here.
coordinate_resources() {
  if [[ -e "$HOME/.portcove/resources/config.json" ]]; then return 0; fi
  node scripts/resource-command.mts retire-legacy-entrypoints
}

install_rust() {
  # Without arguments rustup installs the rust-toolchain.toml channel and components.
  rustup toolchain install
  rustc --version
}

install_prebuilt_tools() {
  local digest bin id version url sha256 member command
  digest="$(node scripts/quality-tools.mts --install-action-digest)"
  mkdir -p "$scratch/manifests"
  # Plans are written by ordinary commands, never process substitution, so a
  # failed planner fails the step instead of silently installing nothing.
  node -e '
    const m = JSON.parse(require("node:fs").readFileSync(".github/quality-tools.json", "utf8"));
    for (const t of m.tools) if (t.tier === "required" && t.ci_install === "prebuilt") console.log(t.crate);
  ' > "$scratch/prebuilt-crates"
  while IFS='|' read -r crate _; do
    fetch "https://raw.githubusercontent.com/taiki-e/install-action/$digest/manifests/$crate.json" \
      "$scratch/manifests/$crate.json"
  done < "$scratch/prebuilt-crates"
  node scripts/quality-tools.mts --prebuilt-plan "$scratch/manifests" > "$scratch/prebuilt-plan"
  bin="${CARGO_HOME:-$HOME/.cargo}/bin"
  mkdir -p "$bin"
  while IFS='|' read -r id version url sha256 member command; do
    if node scripts/quality-tools.mts --verify "$id" >/dev/null 2>&1; then
      printf 'Using installed %s %s.\n' "$id" "$version"
      continue
    fi
    fetch "$url" "$scratch/$id.tar.gz"
    printf '%s  %s\n' "$sha256" "$scratch/$id.tar.gz" | sha256sum --check --status
    mkdir -p "$scratch/$id"
    tar -xzf "$scratch/$id.tar.gz" -C "$scratch/$id"
    [[ -f "$scratch/$id/$member" && ! -L "$scratch/$id/$member" ]]
    install -m 0755 "$scratch/$id/$member" "$bin/$(basename "$member")"
    node scripts/quality-tools.mts --verify "$id"
    printf 'Installed %s %s (%s).\n' "$id" "$version" "$command"
  done < "$scratch/prebuilt-plan"
}

# Remaining required tools have no reviewed prebuilt artifact. Cached tools use
# CI's checksum-verified archived-source installer; others reuse the quality
# bootstrap's exact-version installer, so neither depends on the Aqua step.
install_source_tools() {
  local bin id install spec root
  bin="${CARGO_HOME:-$HOME/.cargo}/bin"
  # shellcheck source=scripts/bootstrap-quality-tools.sh
  source scripts/bootstrap-quality-tools.sh
  node -e '
    const m = JSON.parse(require("node:fs").readFileSync(".github/quality-tools.json", "utf8"));
    for (const t of m.tools) if (t.tier === "required" && t.ci_install !== "prebuilt")
      console.log([t.id, t.ci_install, [t.crate, t.version, t.command.join(" ")].join("|")].join("|"));
  ' > "$scratch/source-plan"
  while IFS='|' read -r id install spec; do
    if node scripts/quality-tools.mts --verify "$id" >/dev/null 2>&1; then continue; fi
    if [[ "$install" == cached ]]; then
      root="$HOME/.local/share/portcove-qualification-$id"
      [[ ! -e "$root" ]] || { printf 'Remove the unverified %s before reinstalling.\n' "$root" >&2; return 1; }
      mkdir -p "$(dirname "$root")"
      python3 -I scripts/install-qualification-rscheck.py .github/quality-tools.json "$root"
      for executable in "$root"/bin/*; do ln -sfn "$executable" "$bin/$(basename "$executable")"; done
      node scripts/quality-tools.mts --verify "$id"
    else
      install_tool "$spec"
    fi
  done < "$scratch/source-plan"
}

install_aqua() {
  local version record archive bytes sha256 base
  version="$(tr -d '\r\n' < .aqua-version)"
  if [[ "$(aqua --version 2>/dev/null || true)" != *" ${version#v}" ]]; then
    record="$(node -e '
      const c = JSON.parse(require("node:fs").readFileSync(".config/tool-bootstrap.json", "utf8"));
      if (c.aqua.version !== process.argv[1]) throw new Error(".aqua-version differs from .config/tool-bootstrap.json");
      const a = c.aqua.artifacts["linux-x64"];
      console.log([c.aqua.release_base, a.archive, a.bytes, a.sha256.toLowerCase()].join("|"));
    ' "$version")"
    IFS='|' read -r base archive bytes sha256 <<<"$record"
    [[ "$base" == https://github.com/* && "$bytes" =~ ^[1-9][0-9]*$ && "$sha256" =~ ^[0-9a-f]{64}$ ]]
    fetch "$base/$version/$archive" "$scratch/aqua.tar.gz"
    [[ "$(stat -c '%s' "$scratch/aqua.tar.gz")" == "$bytes" ]]
    printf '%s  %s\n' "$sha256" "$scratch/aqua.tar.gz" | sha256sum --check --status
    tar -xzf "$scratch/aqua.tar.gz" -C "$scratch" aqua
    install -m 0755 "$scratch/aqua" "$(link_dir)/aqua"
    hash -r
  fi
  if bash scripts/bootstrap-quality-tools.sh 2>&1 | tee "$scratch/aqua.log"; then return 0; fi
  if aqua_failure_is_attestation_only "$scratch/aqua.log"; then
    printf 'Ruff and actionlint are unavailable here: their GitHub artifact attestation is not\n'
    printf 'readable from this session. Their lint runs in hosted CI; other Aqua tools are ready.\n'
    return 0
  fi
  return 1
}

install_browser() {
  node scripts/dev-storage.mts run -- pnpm --dir apps/desktop browser:bootstrap
}

install_desktop() {
  bash scripts/install-linux-desktop-prerequisites.sh
}

# The container build already pins PowerShell with its archive checksum; reuse
# that single pin so Windows-shaped script fixtures run on Linux too.
install_powershell() {
  local version sha256 destination
  version="$(sed -n 's/^ARG POWERSHELL_VERSION=//p' tools/containers/build/Dockerfile)"
  sha256="$(sed -n 's/^ARG POWERSHELL_SHA256=//p' tools/containers/build/Dockerfile)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$sha256" =~ ^[0-9a-f]{64}$ ]]
  if [[ "$(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' 2>/dev/null || true)" == "$version" ]]; then
    return 0
  fi
  fetch "https://github.com/PowerShell/PowerShell/releases/download/v$version/powershell-$version-linux-x64.tar.gz" \
    "$scratch/powershell.tar.gz"
  printf '%s  %s\n' "$sha256" "$scratch/powershell.tar.gz" | sha256sum --check --status
  destination="/opt/microsoft/powershell/$version"
  mkdir -p "$destination"
  tar -xzf "$scratch/powershell.tar.gz" -C "$destination"
  chmod 0755 "$destination/pwsh"
  ln -sfn "$destination/pwsh" "$(link_dir)/pwsh"
  hash -r
  [[ "$(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')" == "$version" ]]
}

# Fixtures that inspect commits and merge bases need the real history; a shallow
# cloud clone otherwise makes them fail for reasons unrelated to the change.
complete_history() {
  if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then git fetch --quiet --unshallow origin; fi
}

# Release and native fixtures deliberately refuse root and inherited proxy TLS
# settings. scripts/cloud-test.sh runs offline commands as this ordinary
# identity in its own copy of the checkout, so no permission here changes.
create_test_user() {
  local user=portcove-test
  id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
  printf '[user]\n\tname = Portcove Fixture\n\temail = fixture@example.invalid\n' \
    > "/home/$user/.gitconfig"
  chown "$user:" "/home/$user/.gitconfig"
  # The identity has its own resource domain; give it the same first-use cutover.
  if [[ ! -e "/home/$user/.portcove/resources/config.json" ]]; then
    runuser -u "$user" -- env -i PATH="$PATH" HOME="/home/$user" \
      node "$project_root/scripts/resource-command.mts" retire-legacy-entrypoints
  fi
}

# The test identity cannot traverse /root, where rustup installs. Move rustup's
# home and the cargo bin directory to root-owned, world-readable /opt paths and
# leave symlinks behind, so root's tooling is unchanged and scripts/cloud-test.sh
# can run offline cargo commands without opening /root or letting the test
# identity modify the toolchain.
share_rust_toolchain() {
  local shared=/opt/portcove-rust pair source target
  install -d -m 0755 "$shared"
  for pair in "${RUSTUP_HOME:-$HOME/.rustup}|rustup" "${CARGO_HOME:-$HOME/.cargo}/bin|cargo-bin"; do
    source="${pair%|*}"
    target="$shared/${pair#*|}"
    if [[ -L "$source" && "$(readlink -- "$source")" == "$target" ]]; then continue; fi
    if [[ ! -d "$source" || -L "$source" || -e "$target" ]]; then
      printf 'Cannot share %s at %s; it is not a directory or the target exists.\n' "$source" "$target" >&2
      return 1
    fi
    mv -- "$source" "$target"
    ln -s -- "$target" "$source"
  done
  runuser -u portcove-test -- env -i PATH="$shared/cargo-bin:/usr/bin:/bin" \
    RUSTUP_HOME="$shared/rustup" CARGO_HOME=/home/portcove-test/.cargo cargo --version
}

step node install_node
step frontend install_frontend
step resources coordinate_resources
step rust install_rust
step prebuilt-tools install_prebuilt_tools
step source-tools install_source_tools
step aqua install_aqua
if ! $skip_browser; then step browser install_browser; fi
if ! $skip_desktop; then step desktop install_desktop; fi
step powershell install_powershell
step history complete_history
step test-user create_test_user
step test-toolchain share_rust_toolchain

printf '\n'
node scripts/dev-doctor.mts || true
if (( ${#failures[@]} )); then
  printf '\nCloud bootstrap incomplete: %s. Rerun this script after resolving the reported step.\n' "${failures[*]}" >&2
  exit 1
fi
printf '\nCloud bootstrap complete.\n'
