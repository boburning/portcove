#!/usr/bin/env bash
set -euo pipefail

fixture=scripts/fixtures/published-macos-smoke.json
evidence=${1:?Supply a new evidence directory}
package=${2:?Supply a new package directory}
jq -e '.schema_version==1 and .release!=null' "$fixture" >/dev/null
version=$(jq -er '.release.version|select(.=="0.1.0-preview.11")' "$fixture")
source=$(jq -er '.release.source|select(test("^[a-f0-9]{40}$"))' "$fixture")
release_id=$(jq -er '.release.release_id|select(type=="number" and .>0)' "$fixture")
tag=nightly-$version
repo=boburning/portcove
asset=Portcove_${version}_universal.app.tar.gz
base=https://github.com/$repo/releases/download/$tag

test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test "$(git rev-parse "refs/tags/$tag^{commit}")" = "$source"
mkdir -- "$evidence" "$package"
export LC_ALL=C
: "${GH_TOKEN:?Hosted release metadata needs the read-only workflow token}"
(( ${#GH_TOKEN} <= 4096 )) && [[ $GH_TOKEN =~ ^[A-Za-z0-9._~+/-]+=*$ ]] ||
  { echo 'Invalid release metadata token format' >&2; exit 1; }
printf 'Accept: application/vnd.github+json\nAuthorization: Bearer %s\n' "$GH_TOKEN" |
  curl -q -fsS --proto '=https' --max-time 45 --max-filesize 1048576 --header @- \
    --output "$evidence/release.json" --write-out 'Release metadata HTTP %{http_code}\n' \
    "https://api.github.com/repos/$repo/releases/tags/$tag" | tee "$evidence/release-fetch-status.txt"
unset GH_TOKEN
jq -e --arg tag "$tag" --arg source "$source" --argjson release_id "$release_id" '
  .id==$release_id and .tag_name==$tag and .target_commitish==$source and
  .immutable==true and .draft==false and .prerelease==true
' "$evidence/release.json" >/dev/null

fetch_asset() {
  local field=$1 name=$2 cap=$3 bytes digest id url
  bytes=$(jq -er --arg field "$field" --argjson cap "$cap" '.release[$field].bytes|select(type=="number" and .>0 and .<=$cap)' "$fixture")
  digest=$(jq -er --arg field "$field" '.release[$field].sha256|select(test("^[a-f0-9]{64}$"))' "$fixture")
  id=$(jq -er --arg field "$field" '.release[$field].id|select(type=="number" and .>0)' "$fixture")
  url="$base/$name"
  jq -e --arg name "$name" --arg url "$url" --arg digest "$digest" --argjson id "$id" --argjson bytes "$bytes" '
    [.assets[]|select(.name==$name)] | length==1 and .[0].state=="uploaded" and
    .[0].id==$id and .[0].size==$bytes and .[0].digest==("sha256:"+$digest) and .[0].browser_download_url==$url
  ' "$evidence/release.json" >/dev/null
  curl -q -fsSL --proto '=https' --proto-redir '=https' --max-time 180 --max-filesize "$bytes" \
    --output "$package/$name" "$url"
  test "$(stat -f '%z' "$package/$name")" = "$bytes"
  printf '%s  %s\n' "$digest" "$package/$name" | shasum -a 256 -c
}

fetch_asset archive "$asset" 268435456
fetch_asset signature "$asset.sig" 16384
fetch_asset checksums SHA256SUMS 65536
(
  cd "$package"
  for name in "$asset" "$asset.sig"; do
    awk -v name="$name" '$2==name {print; hits++} END {if(hits!=1) exit 1}' SHA256SUMS | shasum -a 256 -c
  done
)
cp -- "$package/SHA256SUMS" "$evidence/SHA256SUMS"
git show "$source:apps/desktop/src-tauri/tauri.conf.json" |
  jq -er '.plugins.updater.pubkey' | /usr/bin/base64 -D > "$package/updater.pub"
key_hash=$(jq -er '.release.updater_key_sha256|select(test("^[a-f0-9]{64}$"))' "$fixture")
printf '%s  %s\n' "$key_hash" "$package/updater.pub" | shasum -a 256 -c
/usr/bin/base64 -D < "$package/$asset.sig" > "$package/app.minisig"
minisign -Vm "$package/$asset" -x "$package/app.minisig" -p "$package/updater.pub" | tee "$evidence/signature.log"
awk -F '\t' -v version="version:$version" '
  /^Trusted comment: timestamp:[0-9]+\t/ && $2=="file:Portcove.app.tar.gz" && $3==version && NF==3 { valid++ }
  END { if(valid!=1) exit 1 }
' "$evidence/signature.log"
jq --arg asset "$asset" '.release + {archive_name:$asset}' "$fixture" > "$evidence/published-binding.json"
