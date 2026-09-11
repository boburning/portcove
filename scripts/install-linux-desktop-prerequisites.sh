#!/usr/bin/env bash
set -euo pipefail

packages=(
  libwebkit2gtk-4.1-dev
  libappindicator3-dev
  librsvg2-dev
  patchelf
)
if (( $# > 1 )); then
  echo "usage: $0 [--include-rpm]" >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --include-rpm) packages+=(rpm) ;;
  *)
    echo "usage: $0 [--include-rpm]" >&2
    exit 2
    ;;
esac
readonly packages

missing_packages=()
for package in "${packages[@]}"; do
  if ! dpkg-query --show --showformat='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii '; then
    missing_packages+=("$package")
  fi
done

if (( ${#missing_packages[@]} == 0 )); then
  echo "Linux desktop prerequisites are already installed."
  exit 0
fi
echo "Installing missing Linux desktop prerequisites: ${missing_packages[*]}"

# These prerequisites come from Ubuntu; unrelated runner repositories must not
# participate in resolving this build's dependency set.
ubuntu_sources=/etc/apt/sources.list
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
fi
if [[ ! -s "$ubuntu_sources" ]]; then
  echo "Ubuntu package sources are missing: $ubuntu_sources" >&2
  exit 1
fi

# APT owns retries for individual indexes and packages. Each invocation also
# has a hard process deadline so one stalled mirror cannot consume the complete
# workflow step budget.
apt_options=(
  -o "Dir::Etc::sourcelist=$ubuntu_sources"
  -o Dir::Etc::sourceparts=-
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
  -o Acquire::Retries=3
  -o DPkg::Lock::Timeout=60
)

run_apt() {
  local deadline=$1
  shift
  sudo timeout --kill-after=10s "$deadline" env DEBIAN_FRONTEND=noninteractive \
    apt-get "${apt_options[@]}" "$@"
}

install_from_current_mirror() {
  local label=$1
  local update_deadline=$2
  local install_deadline=$3
  echo "Trying Linux desktop prerequisites from $label."
  if ! run_apt "$update_deadline" update; then
    echo "Ubuntu package index failed from $label." >&2
    return 1
  fi
  if ! run_apt "$install_deadline" install \
    --yes \
    --no-install-recommends \
    "${packages[@]}"; then
    echo "Ubuntu package installation failed from $label." >&2
    return 1
  fi
}

if install_from_current_mirror "the runner-configured mirror" 2m 3m; then
  exit 0
fi

# GitHub's Azure-backed Ubuntu mirror has repeatedly throttled concurrent jobs.
# Fall back to the archive mirror in both supported runner image formats. If a
# runner already uses another mirror, the second attempt still gets the longer
# bounded retry window without rewriting that source.
echo "Retrying Linux desktop prerequisites with the archive mirror fallback."
for source in /etc/apt/sources.list /etc/apt/apt-mirrors.txt; do
  if [[ -f "$source" ]]; then
    sudo sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' "$source"
  fi
done
if install_from_current_mirror "the archive mirror fallback" 4m 5m; then
  exit 0
fi

echo "Linux desktop prerequisites could not be installed from either bounded mirror attempt." >&2
exit 1
