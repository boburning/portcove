#!/usr/bin/env bash
set -euo pipefail

include_deep=false
profile=standard
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) printf 'usage: %s [--include-deep] [--profile standard|frontend|core|daily|native-desktop] [--help]\n' "$0"; exit 0 ;;
    --include-deep) include_deep=true; shift ;;
    --profile) [[ $# -ge 2 ]] || { printf '%s\n' '--profile requires a value' >&2; exit 2; }; profile="$2"; shift 2 ;;
    *) printf 'unknown bootstrap option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

want_frontend=false
want_rust=true
want_aqua=true
capability_plan=""
if [[ "$profile" != standard ]]; then
  capability_plan="$(node scripts/development-capabilities.mjs --profile "$profile")"
  plan_flag() { node -e 'const p=JSON.parse(process.argv[1]); process.exit(p.setup[process.argv[2]] ? 0 : 1)' "$capability_plan" "$1"; }
  plan_flag frontend && want_frontend=true
  if $include_deep; then printf '%s\n' 'Selective profiles cannot be combined with --include-deep' >&2; exit 2; fi
  want_rust=false; plan_flag rust && want_rust=true
  want_aqua=false; plan_flag aqua && want_aqua=true
  if plan_flag native; then
    printf '%s\n' 'Selective native-desktop setup is unavailable on this bootstrap; use the existing approved native platform setup, then doctor --profile native-desktop.' >&2
    exit 1
  fi
fi
if $want_frontend; then
  node_pin="$(tr -d '\r\n' < .node-version)"
  [[ "$(node --version)" == "v$node_pin" ]] || { printf 'Node %s is required for frontend setup.\n' "$node_pin" >&2; exit 1; }
  package_spec="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json","utf8")).packageManager')"
  corepack "$package_spec" install --frozen-lockfile
  node scripts/hooks-install.mjs
fi
if $want_rust && [[ "$profile" != standard ]]; then
  rust_pin="$(node -e 'console.log(JSON.parse(process.argv[1]).pins.rust)' "$capability_plan")"
  if [[ "$(RUSTUP_AUTO_INSTALL=0 rustc --version 2>/dev/null || true)" != "rustc $rust_pin "* ]] ||
     ! RUSTUP_AUTO_INSTALL=0 cargo fmt --version >/dev/null 2>&1 ||
     ! RUSTUP_AUTO_INSTALL=0 cargo clippy --version >/dev/null 2>&1; then
    rustup toolchain install "$rust_pin" --profile minimal --component rustfmt --component clippy
  fi
fi
if $want_aqua; then

required_aqua="$(tr -d '\r\n' < .aqua-version)"
if ! command -v aqua >/dev/null 2>&1; then
  printf 'aqua %s is required; install it before running this bootstrap.\n' "$required_aqua" >&2
  exit 1
fi
aqua_reported="$(aqua --version 2>&1)" || {
  printf 'aqua could not report its version.\n' >&2
  exit 1
}
aqua_version="${aqua_reported##* }"
if [[ "$aqua_version" != "${required_aqua#v}" ]]; then
  printf 'aqua %s is required; reported: %s\n' "$required_aqua" "$aqua_reported" >&2
  exit 1
fi

tool_paths="$(node scripts/tool-cache.mjs --paths)"
AQUA_ROOT_DIR="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).aquaRoot)' <<<"$tool_paths")"
export AQUA_ROOT_DIR
export AQUA_ENFORCE_CHECKSUM=true
export AQUA_ENFORCE_REQUIRE_CHECKSUM=true
mkdir -p "$AQUA_ROOT_DIR"
aqua install

fi

required_tools=()
if [[ "$profile" == standard ]]; then
  while IFS= read -r tool; do required_tools+=("$tool"); done < <(node scripts/quality-tools.mjs --specs required)
else
  while IFS= read -r tool; do required_tools+=("$tool"); done < <(node -e 'for(const t of JSON.parse(process.argv[1]).setup.cargo_tools) console.log([t.crate,t.version,t.command.join(" ")].join("|"))' "$capability_plan")
fi
optional_tools=()
if $include_deep; then
  while IFS= read -r tool; do optional_tools+=("$tool"); done < <(node scripts/quality-tools.mjs --specs deep)
fi

reported_version() {
  local command_line="$1"
  eval "$command_line" 2>&1
}

has_exact_version() {
  local version="$1"
  local command_line="$2"
  local output
  output="$(reported_version "$command_line")" || return 1
  [[ "$output" =~ (^|[^0-9])${version//./\.}([^0-9]|$) ]]
}

install_tool() {
  local spec="$1"
  local crate version command_line
  IFS='|' read -r crate version command_line <<<"$spec"

  if has_exact_version "$version" "$command_line"; then
    printf '%s already pinned: %s\n' "$crate" "$(reported_version "$command_line")"
    return
  fi

  if command -v cargo-binstall >/dev/null 2>&1; then
    cargo binstall --no-confirm --locked "$crate@$version"
  else
    cargo install --locked --version "$version" "$crate"
  fi

  if ! has_exact_version "$version" "$command_line"; then
    printf '%s did not report required version %s\n' "$crate" "$version" >&2
    return 1
  fi
  printf '%s installed: %s\n' "$crate" "$(reported_version "$command_line")"
}

for tool in "${required_tools[@]}"; do
  install_tool "$tool"
done

optional_failures=()
if $include_deep && ! $want_rust; then
  printf '%s\n' '--include-deep requires a Rust-capable profile' >&2; exit 2
fi
if $include_deep; then
  for tool in "${optional_tools[@]}"; do
    crate="${tool%%|*}"
    if ! install_tool "$tool"; then
      optional_failures+=("$crate")
      printf 'warning: optional %s remains unavailable\n' "$crate" >&2
    fi
  done

fi

if [[ "$profile" != standard ]]; then
  node scripts/dev-doctor.mjs --profile "$profile"
fi
printf 'Requested pinned Portcove tools are ready (%s).\n' "$profile"
if [[ ${#optional_failures[@]} -gt 0 ]]; then
  printf 'warning: optional deep tools unavailable on this host: %s\n' "${optional_failures[*]}" >&2
fi
