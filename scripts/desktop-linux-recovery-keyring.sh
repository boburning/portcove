#!/usr/bin/env bash
# Run only inside the desktop harness's fresh D-Bus session and PID namespace.
set -euo pipefail
umask 077
runtime=${1:?private desktop runtime is required}
shift
test "$#" -gt 0
test -n "${DBUS_SESSION_BUS_ADDRESS:-}"
test -d "$runtime"
root=$(mktemp -d "$runtime/recovery-keyring.XXXXXXXX")
mkdir "$root/home" "$root/runtime" "$root/data" "$root/config" "$root/cache"
export XDG_RUNTIME_DIR="$root/runtime"
export GNOME_KEYRING_CONTROL="$root/runtime"

password=$(/usr/bin/python3 -I -S -c 'from secrets import token_urlsafe; print(token_urlsafe(32))')
HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" \
  /usr/bin/gnome-keyring-daemon --foreground --unlock --components=secrets \
  <<<"$password" >/dev/null 2>&1 &
keyring=$!
unset password
cleanup() {
  kill %1 2>/dev/null || true
  wait "$keyring" 2>/dev/null || true
}
trap cleanup EXIT

ready=false
for _ in {1..10}; do
  if /usr/bin/gdbus call --session --timeout 1 --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner \
    org.freedesktop.secrets | grep -Fxq '(true,)'; then
    ready=true
    break
  fi
  sleep 0.25
done
if [ "$ready" != true ]; then
  printf '%s\n' 'The private recovery Secret Service did not register on its D-Bus session.' >&2
  exit 1
fi
alias=$(/usr/bin/gdbus call --session --timeout 2 --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.ReadAlias default)
if [ "$alias" != "(objectpath '/org/freedesktop/secrets/collection/login',)" ]; then
  printf '%s\n' 'The private recovery Secret Service did not expose the login collection as its default.' >&2
  exit 1
fi
locked=$(/usr/bin/gdbus call --session --timeout 2 --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets/collection/login \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked)
if [ "$locked" != '(<false>,)' ]; then
  printf '%s\n' 'The private recovery Secret Service login collection is still locked.' >&2
  exit 1
fi
(set -C; printf '%s\n' '{"default_collection":"login","locked":false,"scope":"private-recovery-dbus"}' \
  >"$runtime/recovery-keyring-readiness.json")

"$@"
