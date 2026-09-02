#!/usr/bin/env bash
set -euo pipefail

include_deep=false
if [[ "${1:-}" == "--include-deep" ]]; then
  include_deep=true
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--include-deep]\n' "$0" >&2
  exit 2
fi

required_tools=(
  'just|1.58.0|just --version'
  'cargo-shear|1.13.4|cargo shear --version'
  'cargo-deny|0.20.2|cargo deny --version'
  'cargo-modules|0.27.0|cargo modules --version'
  'rscheck-cli|0.1.0|rscheck --version'
)

optional_tools=(
  'semdup|0.2.0|semdup --version'
  'cargo-mutants|27.1.0|cargo mutants --version'
)

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

  if ! rustup toolchain install 1.98.0 --component rustc-dev; then
    optional_failures+=("cargo-hawk")
  elif has_exact_version '0.1.13' 'cargo +1.98.0 hawk --version'; then
    printf 'cargo-hawk already pinned: %s\n' "$(reported_version 'cargo +1.98.0 hawk --version')"
  elif ! RUSTC_BOOTSTRAP=1 cargo +1.98.0 install --locked --version 0.1.13 cargo-hawk; then
    optional_failures+=("cargo-hawk")
  elif ! cargo +1.98.0 hawk --version; then
    optional_failures+=("cargo-hawk")
  fi
fi

printf 'Required pinned Portcove quality tools are ready.\n'
if [[ ${#optional_failures[@]} -gt 0 ]]; then
  printf 'warning: optional deep tools unavailable on this host: %s\n' "${optional_failures[*]}" >&2
fi
