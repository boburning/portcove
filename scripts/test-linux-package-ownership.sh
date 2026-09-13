#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 3 )); then
  echo "usage: $0 <deb|rpm> [BUNDLE_ROOT] [EVIDENCE_ROOT]" >&2
  exit 2
fi

format=$1
if [[ "$format" != deb && "$format" != rpm ]]; then
  echo "package format must be deb or rpm" >&2
  exit 2
fi
if [[ -n "${GITHUB_WORKSPACE:-}" ]]; then
  repo_root=$GITHUB_WORKSPACE
else
  repo_root=$(git rev-parse --show-toplevel)
fi
bundle_root=${2:-"$repo_root/target/release/bundle"}
evidence_root=${3:-"$repo_root/work/linux-package-ownership-$format"}
mkdir -p "$evidence_root"

privilege=()
if (( EUID != 0 )); then
  if ! command -v sudo >/dev/null || ! sudo -n true 2>/dev/null; then
    echo "package ownership qualification requires root or pre-authorized noninteractive sudo" >&2
    exit 1
  fi
  privilege=(sudo -n)
fi
readonly privilege

mapfile -t package_files < <(find "$bundle_root/$format" -maxdepth 1 -type f -name "*.$format" -print)
if (( ${#package_files[@]} != 1 )); then
  echo "expected exactly one $format package below $bundle_root" >&2
  exit 1
fi
readonly package_file=${package_files[0]}

if [[ "$format" == deb ]]; then
  mapfile -t installed_executables < <(
    dpkg-deb --fsys-tarfile "$package_file" |
      tar -tf - |
      sed -n 's|^\./usr/bin/|/usr/bin/|p; s|^usr/bin/|/usr/bin/|p' |
      grep -v '/$'
  )
  package_name=$(dpkg-deb --field "$package_file" Package)
  expected_manager=DEB
else
  mapfile -t installed_executables < <(
    rpm --query --package --list "$package_file" |
      sed -n '\|^/usr/bin/|p'
  )
  package_name=$(rpm --query --package --queryformat '%{NAME}' "$package_file")
  expected_manager=RPM
fi
if (( ${#installed_executables[@]} != 1 )); then
  echo "expected the $format package to contain exactly one /usr/bin executable" >&2
  exit 1
fi
readonly installed_executable=${installed_executables[0]}
if [[ -e "$installed_executable" ]]; then
  echo "qualification runner already has $installed_executable" >&2
  exit 1
fi
if [[ ! "$package_name" =~ ^[A-Za-z0-9][A-Za-z0-9+._-]*$ ]]; then
  echo "package metadata returned an unsafe package name" >&2
  exit 1
fi
readonly package_name expected_manager

package_installed=false
cleanup() {
  if [[ "$package_installed" != true ]]; then
    return
  fi
  if [[ "$format" == deb ]]; then
    "${privilege[@]}" dpkg --purge "$package_name" >/dev/null 2>&1 || true
  else
    "${privilege[@]}" rpm --erase --nodeps "$package_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$format" == deb ]]; then
  "${privilege[@]}" dpkg --install "$package_file"
else
  if ! command -v dnf >/dev/null; then
    echo "RPM qualification requires dnf so package dependencies use the native transaction" >&2
    exit 1
  fi
  "${privilege[@]}" dnf --assumeyes install "$package_file"
fi
package_installed=true

owner_file="$evidence_root/$format-owners.txt"
if [[ "$format" == deb ]]; then
  if ! dpkg-query --search "$installed_executable" >"$owner_file"; then
    echo "installed DEB executable ownership query failed" >&2
    exit 1
  fi
  mapfile -t owner_records <"$owner_file"
  if (( ${#owner_records[@]} != 1 )); then
    echo "installed DEB executable does not have exactly one package owner" >&2
    exit 1
  fi
  owner_package=${owner_records[0]%%: /*}
  owner_path=${owner_records[0]##*: }
  if [[ "${owner_package%%:*}" != "$package_name" || "$owner_path" != "$installed_executable" ]]; then
    echo "installed DEB executable owner does not match its package" >&2
    exit 1
  fi
else
  if ! rpm --query --queryformat '%{NAME}\n' --file "$installed_executable" >"$owner_file"; then
    echo "installed RPM executable ownership query failed" >&2
    exit 1
  fi
  mapfile -t owner_records <"$owner_file"
  if (( ${#owner_records[@]} != 1 )) || [[ "${owner_records[0]}" != "$package_name" ]]; then
    echo "installed RPM executable does not have exactly one expected package owner" >&2
    printf 'expected: %s\nobserved: %s\n' "$package_name" "${owner_records[*]:-<none>}" >&2
    exit 1
  fi
fi

hash_before=$(sha256sum "$installed_executable" | cut -d ' ' -f 1)
installed_mode=$(stat -c '%a' "$installed_executable")
guidance_file="$evidence_root/$format-guidance.txt"
set +e
env -u APPIMAGE -u APPDIR -u DISPLAY \
  "$installed_executable" --application-update-recovery eligibility \
  >"$guidance_file" 2>&1
eligibility_status=$?
set -e
if (( eligibility_status != 1 )); then
  echo "$expected_manager eligibility returned $eligibility_status instead of 1" >&2
  cat "$guidance_file" >&2
  exit 1
fi
grep -Fq "This Portcove $expected_manager installation is managed by its package manager." "$guidance_file"
grep -Fq "Update it through the same package source; Portcove did not modify package-managed files." "$guidance_file"
grep -Fq "No update check, download, install, restart, or native prompt was started." "$guidance_file"
hash_after=$(sha256sum "$installed_executable" | cut -d ' ' -f 1)
if [[ "$hash_before" != "$hash_after" ]]; then
  echo "$expected_manager eligibility modified the package-managed executable" >&2
  exit 1
fi

if [[ "$format" == deb ]]; then
  "${privilege[@]}" dpkg --purge "$package_name"
else
  "${privilege[@]}" rpm --erase --nodeps "$package_name"
fi
package_installed=false
if [[ -e "$installed_executable" ]]; then
  echo "$expected_manager removal retained the package executable" >&2
  exit 1
fi

export PORTCOVE_EVIDENCE_ROOT="$evidence_root"
checkout_commit=$(git -c safe.directory="$repo_root" -C "$repo_root" rev-parse HEAD)
PORTCOVE_SOURCE_COMMIT=${PORTCOVE_SOURCE_COMMIT:-${GITHUB_SHA:-$checkout_commit}}
if [[ ! "$PORTCOVE_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ || "$PORTCOVE_SOURCE_COMMIT" != "$checkout_commit" ]]; then
  echo "source commit must equal the exact checked-out commit" >&2
  exit 1
fi
export PORTCOVE_SOURCE_COMMIT
export PORTCOVE_PACKAGE_FORMAT="$format"
PORTCOVE_PACKAGE_FILE=$(basename "$package_file")
PORTCOVE_PACKAGE_SHA256=$(sha256sum "$package_file" | cut -d ' ' -f 1)
export PORTCOVE_PACKAGE_FILE PORTCOVE_PACKAGE_SHA256
export PORTCOVE_PACKAGE_NAME="$package_name"
export PORTCOVE_INSTALLED_SHA256="$hash_after"
export PORTCOVE_INSTALLED_MODE="$installed_mode"
export PORTCOVE_INSTALLED_EXECUTABLE="$installed_executable"
export PORTCOVE_GUIDANCE_FILE="$guidance_file"
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.PORTCOVE_EVIDENCE_ROOT;
const evidence = {
  schema_version: 1,
  source_commit: process.env.PORTCOVE_SOURCE_COMMIT,
  platform: {
    architecture: process.arch,
    os_release: readFileSync("/etc/os-release", "utf8")
      .split("\n")
      .find((line) => line.startsWith("PRETTY_NAME="))
      ?.slice("PRETTY_NAME=".length)
      .replace(/^"|"$/g, ""),
  },
  package: {
    format: process.env.PORTCOVE_PACKAGE_FORMAT,
    filename: process.env.PORTCOVE_PACKAGE_FILE,
    name: process.env.PORTCOVE_PACKAGE_NAME,
    package_sha256: process.env.PORTCOVE_PACKAGE_SHA256,
    installed_executable: process.env.PORTCOVE_INSTALLED_EXECUTABLE,
    installed_sha256: process.env.PORTCOVE_INSTALLED_SHA256,
    installed_mode: process.env.PORTCOVE_INSTALLED_MODE,
    guidance: readFileSync(process.env.PORTCOVE_GUIDANCE_FILE, "utf8").trim(),
  },
  display_unset: true,
  package_managed_files_unchanged: true,
};
writeFileSync(join(root, "package-ownership-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
NODE

echo "$expected_manager package ownership guidance passed."
