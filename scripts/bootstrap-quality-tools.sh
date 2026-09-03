#!/usr/bin/env bash
set -euo pipefail

include_deep=false
if [[ "${1:-}" == "--include-deep" ]]; then
  include_deep=true
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--include-deep]\n' "$0" >&2
  exit 2
fi

required_tools=()
while IFS= read -r tool; do required_tools+=("$tool"); done < <(node scripts/quality-tools.mjs --specs required)
optional_tools=()
while IFS= read -r tool; do optional_tools+=("$tool"); done < <(node scripts/quality-tools.mjs --specs deep)

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
if $include_deep; then
  for tool in "${optional_tools[@]}"; do
    crate="${tool%%|*}"
    if ! install_tool "$tool"; then
      optional_failures+=("$crate")
      printf 'warning: optional %s remains unavailable\n' "$crate" >&2
    fi
  done

  hawk_version="$(node scripts/quality-tools.mjs --version cargo-hawk)"
  hawk_rust="$(node scripts/quality-tools.mjs --rust-toolchain cargo-hawk)"
  if ! rustup toolchain install "$hawk_rust" --component rustc-dev; then
    optional_failures+=("cargo-hawk")
  elif has_exact_version "$hawk_version" "cargo +$hawk_rust hawk --version"; then
    printf 'cargo-hawk already pinned: %s\n' "$(reported_version "cargo +$hawk_rust hawk --version")"
  elif ! RUSTC_BOOTSTRAP=1 cargo "+$hawk_rust" install --locked --version "$hawk_version" cargo-hawk; then
    optional_failures+=("cargo-hawk")
  elif ! cargo "+$hawk_rust" hawk --version; then
    optional_failures+=("cargo-hawk")
  fi
fi

printf 'Required pinned Portcove quality tools are ready.\n'
if [[ ${#optional_failures[@]} -gt 0 ]]; then
  printf 'warning: optional deep tools unavailable on this host: %s\n' "${optional_failures[*]}" >&2
fi
