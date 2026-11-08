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
# Keep the read token in the API request only. Fetch any signed download
# location separately without authentication or further redirects.
api_token="${GH_TOKEN:?GitHub read token required}"
unset GH_TOKEN
[[ "$api_token" =~ ^[A-Za-z0-9._-]{20,4096}$ ]]
response="$(printf 'Authorization: Bearer %s\n' "$api_token" | curl --disable \
  --silent --show-error --proto '=https' --connect-timeout 10 --max-time 25 \
  --max-filesize "$bytes" --header @- --header 'Accept: application/octet-stream' \
  --output "$archive" --write-out '%{http_code} %{redirect_url}' \
  "https://api.github.com/repos/aquaproj/aqua/releases/assets/$asset_id")"
unset api_token
case "$response" in
  '200 ') ;;
  '302 '*)
    location="${response#302 }"
    [[ "$location" == https://release-assets.githubusercontent.com/* ]]
    [[ "$location" != *'"'* && "$location" != *'\'* && "$location" != *[[:space:][:cntrl:]]* ]]
    printf 'url = "%s"\n' "$location" | curl --disable --config - --globoff \
      --fail --silent --show-error --proto '=https' --connect-timeout 10 --max-time 35 \
      --max-filesize "$bytes" --output "$archive"
    ;;
  *)
    printf 'Official Aqua asset API refused download (HTTP %.3s).\n' "$response" >&2
    exit 1
    ;;
esac
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
