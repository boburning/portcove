#!/bin/sh
set -eu
# Installed only inside the dedicated scratch distribution. No caller paths.
test "$#" -eq 1
expected="$1"
case "$expected" in *[!a-f0-9-]*|'') exit 2 ;; esac
source=/data
destination=/mnt/wsl/portcove-scratch
actual="$(findmnt -n -o UUID --target "$source")"
test "$actual" = "$expected"
test -d "$source"
test ! -L "$source"
test -f "$source/.portcove-scratch.json"
test ! -L "$destination"
mkdir -p "$destination"
if mountpoint -q "$destination"; then
  test "$(findmnt -n -o UUID --target "$destination")" = "$expected"
  test "$(stat -c '%d:%i' "$source")" = "$(stat -c '%d:%i' "$destination")"
else
  test -z "$(ls -A "$destination")"
  mount --bind "$source" "$destination"
fi
printf '%s\n' "$actual"
