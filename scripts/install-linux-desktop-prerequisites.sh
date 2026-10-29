#!/usr/bin/env bash

# Sourceable operations; importing this file performs no I/O or option changes.
# Planning writes packages and finite budget/mirror outputs in the caller's scope.
# main owns those variables locally, so repeated controlled calls stay independent.
plan_desktop_prerequisites() {
  local os_id=$1 os_version=$2 option seconds
  local fuse_package=libfuse2
  shift 2
  packages=(
    libwebkit2gtk-4.1-dev
    libappindicator3-dev
    librsvg2-dev
    patchelf
  )
  install_deadline=3m
  fallback_install_deadline=5m
  prefer_archive_mirror=false
  if [[ $os_id == ubuntu && $os_version == 24.04 ]]; then
    fuse_package=libfuse2t64
  fi
  for option in "$@"; do
    case "$option" in
      --include-rpm) packages+=(rpm) ;;
      --include-appimage-runtime) packages+=("$fuse_package" xvfb dbus-x11 at-spi2-core util-linux) ;;
      --include-webdriver) packages+=(webkit2gtk-driver xvfb dbus-x11) ;;
      --include-dialog-tests) packages+=(xvfb xauth) ;;
      --prefer-archive-mirror) prefer_archive_mirror=true ;;
      --install-timeout-seconds=*)
        seconds=${option#*=}
        if [[ ! $seconds =~ ^[0-9]{3,4}$ ]] || (( 10#$seconds < 180 || 10#$seconds > 3600 )); then
          echo "Install timeout must be an integer of 180..3600 seconds." >&2
          return 2
        fi
        install_deadline=$((10#$seconds))s
        fallback_install_deadline=$install_deadline
        ;;
      *)
        echo "usage: $0 [--include-rpm] [--include-appimage-runtime] [--include-webdriver] [--include-dialog-tests] [--prefer-archive-mirror] [--install-timeout-seconds=180..3600]" >&2
        return 2
        ;;
    esac
  done
}

# The selected source is data; the ordinary CLI supplies only its fixed OS paths.
desktop_prerequisite_apt_options() {
  local ubuntu_sources=$1
  apt_options=(
    -o "Dir::Etc::sourcelist=$ubuntu_sources"
    -o Dir::Etc::sourceparts=-
    -o Acquire::http::Timeout=30
    -o Acquire::https::Timeout=30
    -o Acquire::Retries=3
    -o DPkg::Lock::Timeout=60
  )
}

run_apt() {
  local deadline=$1
  shift
  # The deadline owner must share APT's privilege. A user-owned timeout cannot
  # terminate root children after sudo starts its separate process group.
  "${privilege[@]}" timeout --kill-after=10s "$deadline" env DEBIAN_FRONTEND=noninteractive \
    apt-get "${apt_options[@]}" "$@"
}

use_archive_mirror() {
  # Cover the selected legacy/deb822 source and the hosted runner's mirror+file
  # indirection. Preserve unrelated mirrors and lookalike hosts or root paths.
  local source
  for source in "$1" "$2"; do
    if [[ -f "$source" ]]; then
      "${privilege[@]}" sed -i '
:rewrite
s#\(^\|[[:space:]]\)https\?://azure\.archive\.ubuntu\.com/ubuntu\([/[:space:]]\|$\)#\1https://archive.ubuntu.com/ubuntu\2#g
t rewrite
' "$source"
    fi
  done
}

install_from_current_mirror() {
  local label=$1
  local update_deadline=$2
  local install_deadline=$3
  echo "Trying Linux desktop prerequisites from $label."
  echo "APT deadlines: update=$update_deadline, install=$install_deadline (plus 10-second kill grace)."
  if ! run_apt "$update_deadline" update; then
    echo "Ubuntu package index failed from $label." >&2
    return 1
  fi
  if run_apt "$install_deadline" install \
    --yes \
    --no-install-recommends \
    "${packages[@]}"; then
    return 0
  else
    local status=$?
    echo "Ubuntu package installation failed from $label." >&2
    return "$status"
  fi
}

# Preserve the existing distinction: update failures become 1; install timeout
# statuses 124/137 retain their identity and do not retry a possibly interrupted dpkg.
execute_desktop_prerequisites() {
  local status
  if [[ $prefer_archive_mirror == true ]]; then
    echo "Preferring the Ubuntu archive mirror before prerequisite installation."
    use_archive_mirror "$ubuntu_sources" "$apt_mirror_file"
  fi

  if install_from_current_mirror "the runner-configured mirror" 2m "$install_deadline"; then
    return 0
  else
    status=$?
    if (( status == 124 || status == 137 )); then
      # timeout may have interrupted dpkg configuration. A different mirror cannot
      # repair that state; preserve the deadline failure instead of retrying it.
      echo "APT installation exceeded its deadline; refusing a mirror retry on interrupted package state." >&2
      return "$status"
    fi
  fi

  # GitHub's Azure-backed Ubuntu mirror has repeatedly throttled concurrent jobs.
  # Fall back to the archive mirror in both supported runner image formats. If a
  # runner already uses another mirror, the second attempt still gets the longer
  # bounded retry window without rewriting that source.
  echo "Retrying Linux desktop prerequisites with the archive mirror fallback."
  use_archive_mirror "$ubuntu_sources" "$apt_mirror_file"
  if install_from_current_mirror "the archive mirror fallback" 4m "$fallback_install_deadline"; then
    return 0
  else
    status=$?
    echo "Linux desktop prerequisites could not be installed from either bounded mirror attempt." >&2
    return "$status"
  fi
}

desktop_prerequisite_privilege() {
  privilege=()
  if (( $1 != 0 )); then
    if ! command -v sudo >/dev/null || ! sudo -n true 2>/dev/null; then
      echo "Linux desktop prerequisites require root or pre-authorized noninteractive sudo." >&2
      return 1
    fi
    privilege=(sudo -n)
  fi
}

main() {
  local -a packages missing_packages privilege apt_options
  local install_deadline fallback_install_deadline prefer_archive_mirror
  local ubuntu_sources apt_mirror_file=/etc/apt/apt-mirrors.txt package
  local os_id='' os_version=''
  local ID=${ID-} VERSION_ID=${VERSION_ID-}
  if [[ -f /etc/os-release ]]; then
    # Ubuntu 24.04 renamed the FUSE 2 runtime package for its time64 transition.
    source /etc/os-release
    os_id=${ID:-}
    os_version=${VERSION_ID:-}
  fi
  if plan_desktop_prerequisites "$os_id" "$os_version" "$@"; then
    :
  else
    return "$?"
  fi
  readonly packages prefer_archive_mirror
  missing_packages=()
  for package in "${packages[@]}"; do
    if ! dpkg-query --show --showformat='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii '; then
      missing_packages+=("$package")
    fi
  done

  if (( ${#missing_packages[@]} == 0 )); then
    echo "Linux desktop prerequisites are already installed."
    return 0
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
    return 1
  fi

  # Never wait for an interactive privilege prompt in automation or an agent-owned
  # shell. Root needs no wrapper; other callers must already have noninteractive
  # sudo authority before any package or source mutation starts.
  if desktop_prerequisite_privilege "$EUID"; then
    :
  else
    return "$?"
  fi
  readonly privilege
  # The timeout owner shares APT's privilege; all native calls remain bounded.
  desktop_prerequisite_apt_options "$ubuntu_sources"
  execute_desktop_prerequisites
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi
