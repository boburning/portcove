#!/usr/bin/env bash
set -euo pipefail

checkout=$(git rev-parse --show-toplevel)
cd "$checkout"
fixture=scripts/fixtures/published-linux-appimage-smoke.json
evidence=${1:?Supply a new evidence directory}
package_dir=${2:?Supply a new package directory}
repo=boburning/portcove
version=$(jq -er '.version|select(test("^0\\.1\\.0-preview\\.[1-9][0-9]*$"))' "$fixture")
source=$(jq -er '.source|select(test("^[a-f0-9]{40}$"))' "$fixture")
release_id=$(jq -er '.release_id|select(type=="number" and .>0)' "$fixture")
appimage="Portcove_${version}_amd64.AppImage"
tag="nightly-$version"
base="https://github.com/$repo/releases/download/$tag"

mkdir -- "$evidence" "$package_dir"
test "$(git rev-parse "refs/tags/$tag^{commit}")" = "$source"
curl -fsSL --proto '=https' --proto-redir '=https' --max-time 45 --max-filesize 1048576 \
  -o "$evidence/release.json" "https://api.github.com/repos/$repo/releases/tags/$tag"
jq -e --arg tag "$tag" --arg source "$source" --argjson release_id "$release_id" '
  .id==$release_id and .tag_name==$tag and .target_commitish==$source and
  .immutable==true and .draft==false and .prerelease==true
' "$evidence/release.json" >/dev/null

fetch_asset() {
  local field=$1 name=$2 cap=$3 bytes digest id url
  bytes=$(jq -er --arg field "$field" --argjson cap "$cap" '.[$field].bytes|select(type=="number" and .>0 and .<=$cap)' "$fixture")
  digest=$(jq -er --arg field "$field" '.[$field].sha256|select(test("^[a-f0-9]{64}$"))' "$fixture")
  id=$(jq -er --arg field "$field" '.[$field].id|select(type=="number" and .>0)' "$fixture")
  url="$base/$name"
  jq -e --arg name "$name" --arg url "$url" --arg digest "$digest" --argjson id "$id" --argjson bytes "$bytes" '
    [.assets[]|select(.name==$name)] | length==1 and
    .[0].id==$id and .[0].size==$bytes and .[0].digest==("sha256:"+$digest) and .[0].browser_download_url==$url
  ' "$evidence/release.json" >/dev/null
  curl -fsSL --proto '=https' --proto-redir '=https' --max-time 180 --max-filesize "$bytes" \
    -o "$package_dir/$name" "$url"
  test "$(stat -c '%s' "$package_dir/$name")" = "$bytes"
  printf '%s  %s\n' "$digest" "$package_dir/$name" | sha256sum -c
}
fetch_asset appimage "$appimage" 268435456
fetch_asset signature "$appimage.sig" 16384
fetch_asset checksums SHA256SUMS 65536

(
  cd "$package_dir"
  for name in "$appimage" "$appimage.sig"; do
    awk -v name="$name" '$2==name {print; hits++} END {if(hits!=1) exit 1}' SHA256SUMS | sha256sum -c
  done
)
cp -- "$package_dir/SHA256SUMS" "$evidence/SHA256SUMS"
git show "$source:apps/desktop/src-tauri/tauri.conf.json" | jq -er '.plugins.updater.pubkey' | base64 -d > "$package_dir/updater.pub"
key_hash=$(jq -er '.updater_key_sha256|select(test("^[a-f0-9]{64}$"))' "$fixture")
printf '%s  %s\n' "$key_hash" "$package_dir/updater.pub" | sha256sum -c
base64 -d "$package_dir/$appimage.sig" > "$package_dir/appimage.minisig"
minisign -Vm "$package_dir/$appimage" -x "$package_dir/appimage.minisig" -p "$package_dir/updater.pub" | tee "$evidence/signature.log"
awk -F '\t' -v file="file:$appimage" -v version="version:$version" '
  /^Trusted comment: timestamp:[0-9]+\t/ && $2==file && $3==version && NF==3 { valid++ }
  END { if(valid!=1) exit 1 }
' "$evidence/signature.log"
file "$package_dir/$appimage" | tee "$evidence/appimage-format.txt"
grep -q 'ELF 64-bit.*x86-64' "$evidence/appimage-format.txt"
chmod 0755 -- "$package_dir/$appimage"
jq --arg appimage "$appimage" '{schema_version:1, release_id, version, source, appimage:(.appimage + {name:$appimage}), signature, checksums, updater_key_sha256}' "$fixture" > "$evidence/published-binding.json"
