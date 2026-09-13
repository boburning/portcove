#!/usr/bin/env bash
set -euo pipefail

if (( $# > 2 )); then
  echo "usage: $0 [BUNDLE_ROOT] [EVIDENCE_ROOT]" >&2
  exit 2
fi

repo_root=$(git rev-parse --show-toplevel)
bundle_root=${1:-"$repo_root/target/release/bundle"}
evidence_root=${2:-"$repo_root/work/linux-package-ownership"}
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

mapfile -t deb_files < <(find "$bundle_root/deb" -maxdepth 1 -type f -name '*.deb' -print)
mapfile -t rpm_files < <(find "$bundle_root/rpm" -maxdepth 1 -type f -name '*.rpm' -print)
if (( ${#deb_files[@]} != 1 || ${#rpm_files[@]} != 1 )); then
  echo "expected exactly one DEB and one RPM below $bundle_root" >&2
  exit 1
fi
readonly deb_file=${deb_files[0]}
readonly rpm_file=${rpm_files[0]}

mapfile -t deb_executables < <(
  dpkg-deb --fsys-tarfile "$deb_file" |
    tar -tf - |
    sed -n 's|^\./usr/bin/|/usr/bin/|p; s|^usr/bin/|/usr/bin/|p' |
    grep -v '/$'
)
mapfile -t rpm_executables < <(rpm -qlp "$rpm_file" | sed -n '\|^/usr/bin/|p')
if (( ${#deb_executables[@]} != 1 || ${#rpm_executables[@]} != 1 )); then
  echo "expected each package to contain exactly one /usr/bin executable" >&2
  exit 1
fi
if [[ "${deb_executables[0]}" != "${rpm_executables[0]}" ]]; then
  echo "DEB and RPM install different executable paths" >&2
  exit 1
fi
readonly installed_executable=${deb_executables[0]}
if [[ -e "$installed_executable" ]]; then
  echo "qualification runner already has $installed_executable" >&2
  exit 1
fi

deb_package=$(dpkg-deb --field "$deb_file" Package)
rpm_package=$(rpm -qp --queryformat '%{NAME}' "$rpm_file")
if [[ ! "$deb_package" =~ ^[a-z0-9][a-z0-9+.-]*$ || ! "$rpm_package" =~ ^[A-Za-z0-9][A-Za-z0-9+._-]*$ ]]; then
  echo "package metadata returned an unsafe package name" >&2
  exit 1
fi
readonly deb_package rpm_package

deb_installed=false
rpm_installed=false
cleanup() {
  if [[ "$rpm_installed" == true ]]; then
    "${privilege[@]}" rpm --erase --nodeps "$rpm_package" >/dev/null 2>&1 || true
  fi
  if [[ "$deb_installed" == true ]]; then
    "${privilege[@]}" dpkg --purge "$deb_package" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_eligibility() {
  local expected_manager=$1
  local output_file=$2
  local status
  set +e
  env -u APPIMAGE -u APPDIR -u DISPLAY \
    "$installed_executable" --application-update-recovery eligibility \
    >"$output_file" 2>&1
  status=$?
  set -e
  if (( status != 1 )); then
    echo "$expected_manager eligibility returned $status instead of 1" >&2
    cat "$output_file" >&2
    exit 1
  fi
  grep -Fq "This Portcove $expected_manager installation is managed by its package manager." "$output_file"
  grep -Fq "Update it through the same package source; Portcove did not modify package-managed files." "$output_file"
  grep -Fq "No update check, download, install, restart, or native prompt was started." "$output_file"
}

"${privilege[@]}" dpkg --install "$deb_file"
deb_installed=true
mapfile -t deb_owners < <(dpkg-query --search "$installed_executable")
if (( ${#deb_owners[@]} != 1 )); then
  echo "installed DEB executable does not have exactly one package owner" >&2
  exit 1
fi
deb_owner_package=${deb_owners[0]%%: /*}
deb_owner_path=${deb_owners[0]##*: }
[[ "${deb_owner_package%%:*}" == "$deb_package" ]]
[[ "$deb_owner_path" == "$installed_executable" ]]
deb_hash_before=$(sha256sum "$installed_executable" | cut -d ' ' -f 1)
deb_mode=$(stat -c '%a' "$installed_executable")
run_eligibility DEB "$evidence_root/deb-guidance.txt"
deb_hash_after=$(sha256sum "$installed_executable" | cut -d ' ' -f 1)
[[ "$deb_hash_before" == "$deb_hash_after" ]]
"${privilege[@]}" dpkg --purge "$deb_package"
deb_installed=false
[[ ! -e "$installed_executable" ]]

"${privilege[@]}" rpm --install --nodeps "$rpm_file"
rpm_installed=true
mapfile -t rpm_owners < <(
  rpm --query --queryformat '%{NAME}\n' --file "$installed_executable" |
    tee "$evidence_root/rpm-owners.txt"
)
if (( ${#rpm_owners[@]} != 1 )) || [[ "${rpm_owners[0]}" != "$rpm_package" ]]; then
  echo "installed RPM executable does not have exactly one expected package owner" >&2
  printf 'expected: %s\nobserved: %s\n' "$rpm_package" "${rpm_owners[*]:-<none>}" >&2
  exit 1
fi
rpm_hash_before=$(sha256sum "$installed_executable" | cut -d ' ' -f 1)
rpm_mode=$(stat -c '%a' "$installed_executable")
run_eligibility RPM "$evidence_root/rpm-guidance.txt"
rpm_hash_after=$(sha256sum "$installed_executable" | cut -d ' ' -f 1)
[[ "$rpm_hash_before" == "$rpm_hash_after" ]]
"${privilege[@]}" rpm --erase --nodeps "$rpm_package"
rpm_installed=false
[[ ! -e "$installed_executable" ]]

export PORTCOVE_EVIDENCE_ROOT="$evidence_root"
export PORTCOVE_SOURCE_COMMIT="${GITHUB_SHA:-$(git rev-parse HEAD)}"
export PORTCOVE_DEB_FILE="$(basename "$deb_file")"
export PORTCOVE_DEB_SHA256="$(sha256sum "$deb_file" | cut -d ' ' -f 1)"
export PORTCOVE_DEB_PACKAGE="$deb_package"
export PORTCOVE_DEB_BINARY_SHA256="$deb_hash_after"
export PORTCOVE_DEB_BINARY_MODE="$deb_mode"
export PORTCOVE_RPM_FILE="$(basename "$rpm_file")"
export PORTCOVE_RPM_SHA256="$(sha256sum "$rpm_file" | cut -d ' ' -f 1)"
export PORTCOVE_RPM_PACKAGE="$rpm_package"
export PORTCOVE_RPM_BINARY_SHA256="$rpm_hash_after"
export PORTCOVE_RPM_BINARY_MODE="$rpm_mode"
export PORTCOVE_INSTALLED_EXECUTABLE="$installed_executable"
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
  installed_executable: process.env.PORTCOVE_INSTALLED_EXECUTABLE,
  display_unset: true,
  packages: {
    deb: {
      filename: process.env.PORTCOVE_DEB_FILE,
      package: process.env.PORTCOVE_DEB_PACKAGE,
      package_sha256: process.env.PORTCOVE_DEB_SHA256,
      installed_sha256: process.env.PORTCOVE_DEB_BINARY_SHA256,
      installed_mode: process.env.PORTCOVE_DEB_BINARY_MODE,
      guidance: readFileSync(join(root, "deb-guidance.txt"), "utf8").trim(),
    },
    rpm: {
      filename: process.env.PORTCOVE_RPM_FILE,
      package: process.env.PORTCOVE_RPM_PACKAGE,
      package_sha256: process.env.PORTCOVE_RPM_SHA256,
      installed_sha256: process.env.PORTCOVE_RPM_BINARY_SHA256,
      installed_mode: process.env.PORTCOVE_RPM_BINARY_MODE,
      guidance: readFileSync(join(root, "rpm-guidance.txt"), "utf8").trim(),
    },
  },
  package_managed_files_unchanged: true,
};
writeFileSync(join(root, "package-ownership-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
NODE

echo "DEB and RPM package ownership guidance passed."
