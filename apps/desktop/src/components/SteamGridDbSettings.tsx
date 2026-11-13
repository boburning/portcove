import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { SteamGridDbKeyStatus } from "../types";
import { steamGridDbErrorText as errorText } from "./SteamGridDbPicker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SettingsRow } from "./ui/patterns";
import { ExternalLink } from "./ExternalLink";

/**
 * Optional SteamGridDB setup. The player's own key goes straight to Core's
 * secure-store entry; the renderer never receives it back, and setting it up
 * starts no lookups on its own.
 */
export function SteamGridDbSettings() {
  const [status, setStatus] = useState<SteamGridDbKeyStatus>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  // Saving or removing replaces the focused control; focus follows the change.
  const keyInput = useRef<HTMLInputElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef(false);
  useEffect(() => {
    if (!focusAfter.current || status === undefined) return;
    focusAfter.current = false;
    (status.configured ? removeButton.current : keyInput.current)?.focus();
  }, [status]);
  useEffect(() => {
    mounted.current = true;
    desktopApi
      .steamGridDbKeyStatus()
      .then((value) => mounted.current && setStatus(value))
      .catch((value: unknown) => mounted.current && setError(errorText(value)));
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (action: () => Promise<SteamGridDbKeyStatus>, done: string) => {
    setBusy(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const next = await action();
      if (!mounted.current) return;
      focusAfter.current = true;
      setStatus(next);
      setKey("");
      setMessage(done);
    } catch (value) {
      if (mounted.current) setError(errorText(value));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <SettingsRow className="col-span-full" data-focus-group>
      <h2>SteamGridDB artwork</h2>
      <p>
        Find covers and wide images made by the SteamGridDB community. This uses your own free API
        key; Portcove does not provide one.
      </p>
      <p role="status">
        {status === undefined
          ? "Checking SteamGridDB setup…"
          : status.configured
            ? "Your SteamGridDB API key is saved on this device."
            : "No SteamGridDB API key is saved."}
      </p>
      {status && !status.configured && (
        <div className="mt-2">
          <label className="block font-semibold" htmlFor="steamgriddb-api-key">
            SteamGridDB API key
          </label>
          <div className="mt-2 flex gap-2">
            <Input
              ref={keyInput}
              id="steamgriddb-api-key"
              data-focusable
              className="flex-1"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button
              data-focusable
              variant="primary"
              size="sm"
              disabled={busy || !key.trim()}
              onClick={() =>
                void run(
                  () => desktopApi.setSteamGridDbKey(key),
                  "SteamGridDB key saved. Use Find on SteamGridDB in a game's artwork settings.",
                )
              }
            >
              Save key
            </Button>
          </div>
          <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            Create a key in your{" "}
            <ExternalLink href="https://www.steamgriddb.com/profile/preferences/api">
              SteamGridDB preferences
            </ExternalLink>
            .
          </p>
        </div>
      )}
      {status?.configured && (
        <Button
          ref={removeButton}
          data-focusable
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(
              () => desktopApi.clearSteamGridDbKey(),
              "SteamGridDB key removed from this device. Images you already chose stay in your library.",
            )
          }
        >
          Remove key
        </Button>
      )}
      <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
        Portcove contacts SteamGridDB only when you use Find on SteamGridDB: to search, list a
        game's images, show their previews or download the image you choose. Those requests send the
        name you search for, SteamGridDB game and image IDs, and ordinary connection details such as
        your IP address. Your key goes only to SteamGridDB's API, never to its image server. Your
        files, game paths and library stay on this device.
      </p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </SettingsRow>
  );
}
