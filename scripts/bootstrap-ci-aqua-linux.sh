#!/usr/bin/env bash
set -euo pipefail

# The upstream installer bootstraps through the browser release URL. Use the
# official binary asset API for this Linux CI job and verify the repo-owned pin.
[[ "$(uname -sm)" == 'Linux x86_64' ]]
version="$(tr -d '\r\n' < .aqua-version)"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
asset="$(jq -er --arg version "$version" '
  select(.schema_version == 1 and .aqua.version == $version)
  | .aqua.artifacts["linux-x64"]
  | select(.archive == "aqua_linux_amd64.tar.gz")
  | [.asset_id, .bytes, .sha256] | @tsv
' .config/tool-bootstrap.json)"
IFS=$'\t' read -r asset_id bytes sha256 <<< "$asset"
[[ "$asset_id" =~ ^[1-9][0-9]{0,15}$ && "$bytes" =~ ^[1-9][0-9]{0,7}$ ]]
[[ "$sha256" =~ ^[0-9A-F]{64}$ ]]
scratch="$(mktemp -d "${RUNNER_TEMP:?}/portcove-ci-aqua.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
archive="$scratch/aqua.tar.gz"
curl --disable --fail --silent --show-error --location --max-redirs 2 \
  --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 \
  --max-filesize "$bytes" --header 'Accept: application/octet-stream' \
  --output "$archive" "https://api.github.com/repos/aquaproj/aqua/releases/assets/$asset_id"
[[ "$(stat -c '%s' "$archive")" == "$bytes" ]]
printf '%s  %s\n' "${sha256,,}" "$archive" | sha256sum --check --status
entry="$(tar --list --verbose --gzip --file "$archive" -- aqua)"
[[ "$entry" == -* && "$entry" != *$'\n'* ]]
tar --extract --to-stdout --gzip --file "$archive" -- aqua > "$scratch/aqua"
chmod 0755 "$scratch/aqua"
reported="$("$scratch/aqua" --version)"
[[ "${reported##* }" == "${version#v}" ]]
destination="${AQUA_ROOT_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/aquaproj-aqua}/bin"
install -D -m 0755 "$scratch/aqua" "$destination/aqua"
printf '%s\n' "$destination" >> "${GITHUB_PATH:?}"
printf 'version=%s\n' "$version" >> "${GITHUB_OUTPUT:?}"
