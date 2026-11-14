import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { desktopApi } from "../api";
import { useArtworkCache } from "../artwork";
import type { SteamGridDbKeyStatus, SteamGridDbListingReport } from "../types";
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
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * One check per library generation, kept outside the component so a remount
 * cannot start a second check, and a summary never outlives its library.
 */
interface ListingCheckState {
  generation: number;
  checking: boolean;
  summary?: string[];
  error?: string;
}
let listingCheck: ListingCheckState = { generation: -1, checking: false };
const listingCheckListeners = new Set<() => void>();
function setListingCheck(next: ListingCheckState) {
  listingCheck = next;
  listingCheckListeners.forEach((listener) => listener());
}
function subscribeListingCheck(listener: () => void) {
  listingCheckListeners.add(listener);
  return () => listingCheckListeners.delete(listener);
}
/** Test isolation only: forgets the last check. */
export function resetSteamGridDbCheckForTests() {
  setListingCheck({ generation: -1, checking: false });
}

/** Player-facing summary of one listing check; removals count only finished ones. */
export function listingSummary(report: SteamGridDbListingReport): string[] {
  if (report.images.length === 0)
    return ["Your library has no SteamGridDB images to check. Nothing was changed."];
  let listed = 0;
  let missing = 0;
  let unconfirmed = 0;
  let unreached = 0;
  for (const image of report.images) {
    if (image.listing.status === "listed") listed += 1;
    else if (image.listing.status === "not_listed") missing += 1;
    else if (image.attempted) unconfirmed += 1;
    else unreached += 1;
  }
  const lines = [
    `${plural(report.images.length, "SteamGridDB image", "SteamGridDB images")}: ${listed} still listed, ${missing} not in SteamGridDB's list when checked, ${unconfirmed} not confirmed.`,
  ];
  if (unreached > 0)
    lines.push(
      `${plural(unreached, "image was", "images were")} not reached this run. Checking again starts with them.`,
    );
  const stop = report.stopped;
  if (stop?.reason === "rate_limited")
    lines.push(
      stop.retry_after_seconds
        ? `SteamGridDB asked Portcove to slow down. Check again in ${plural(Math.max(1, Math.ceil(stop.retry_after_seconds / 60)), "minute", "minutes")}.`
        : "SteamGridDB asked Portcove to slow down. Check again later.",
    );
  else if (stop?.reason === "key_rejected")
    lines.push("SteamGridDB rejected your saved key. Replace it above, then check again.");
  else if (stop?.reason === "unavailable")
    lines.push("SteamGridDB could not be reached. Check again later.");
  else if (stop?.reason === "time_limit")
    lines.push("The check reached its three-minute limit. Check again to continue.");
  else if (stop?.reason === "cancelled")
    lines.push("The check stopped because the library changed. Check again when you are ready.");
  const reached = report.images.some((image) => image.attempted);
  const kept = report.images.filter((image) => image.effect === "withdrawn").length;
  const listedAgain = report.images.filter((image) => image.effect === "listed_again").length;
  if (kept > 0)
    lines.push(
      `${plural(kept, "image is", "images are")} confirmed removed from SteamGridDB. You imported ${kept === 1 ? "it" : "them"} yourself, so Portcove kept ${kept === 1 ? "it" : "them"}.`,
    );
  if (listedAgain > 0)
    lines.push(
      `${plural(listedAgain, "image is", "images are")} listed again. If Portcove removed ${listedAgain === 1 ? "its copy" : "their copies"}, choose ${listedAgain === 1 ? "it" : "them"} again to restore ${listedAgain === 1 ? "it" : "them"}.`,
    );
  const removedNothing = report.removed === 0;
  lines.push(
    !reached
      ? "Nothing was checked this time. Nothing was removed."
      : !report.recorded
        ? "These results were not recorded. Nothing was removed; check again to record them."
        : removedNothing
          ? "Portcove recorded what it found. Nothing was removed."
          : `Portcove recorded what it found and removed ${plural(report.removed, "copy", "copies")} of images SteamGridDB no longer lists. Your choices and credits were kept, and nothing changed in Steam.`,
  );
  if (report.removal_deferred > 0)
    lines.push(
      `${plural(report.removal_deferred, "more copy", "more copies")} will be removed by the next check, export or move.`,
    );
  if (report.removal_failed > 0)
    lines.push(
      `Portcove couldn't remove ${plural(report.removal_failed, "copy", "copies")}. ${report.removal_failed === 1 ? "It is" : "They are"} no longer shown or used. Close any program that may be using Portcove's artwork folder, then check again.`,
    );
  if (report.skipped > 0)
    lines.push(
      `${plural(report.skipped, "result", "results")} could not be recorded and will be checked first next time.`,
    );
  return lines;
}

export function SteamGridDbSettings({ generation }: { generation: number }) {
  const [status, setStatus] = useState<SteamGridDbKeyStatus>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const stored = useSyncExternalStore(
    subscribeListingCheck,
    () => listingCheck,
    () => listingCheck,
  );
  const current = stored.generation === generation ? stored : undefined;
  const checking = current?.checking ?? false;
  const summary = current?.summary;
  const artwork = useArtworkCache();
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
  const check = async () => {
    if (listingCheck.generation === generation && listingCheck.checking) return;
    setListingCheck({ generation, checking: true });
    setError(undefined);
    let next: ListingCheckState = { generation, checking: false };
    try {
      const report = await desktopApi.checkSteamGridDbListings(generation);
      next = { generation, checking: false, summary: listingSummary(report) };
      // Shown artwork follows what the check changed, without a restart.
      const changed = new Set(
        report.images
          .filter((image) => report.recorded && image.effect !== "none")
          .map((image) => image.asset_sha256),
      );
      if (changed.size > 0 && artwork?.generation === generation)
        artwork.refreshAfterListingCheck(changed);
    } catch (value) {
      next = { generation, checking: false, error: errorText(value) };
    } finally {
      // A newer library's check is never overwritten by an older one.
      if (listingCheck.generation === generation) setListingCheck(next);
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
      {status?.configured && (
        <div aria-busy={checking}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-focusable
            disabled={busy || checking}
            onClick={() => void check()}
          >
            {checking ? "Checking SteamGridDB images…" : "Check SteamGridDB images"}
          </Button>
          <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            Checks whether SteamGridDB still lists the images you chose from it and records what it
            finds. If a later check confirms that SteamGridDB removed an image, Portcove removes its
            copy unless you imported the image yourself; your choice and the credit are kept, and
            nothing changes in Steam. A check takes up to three minutes and starts with the images
            checked longest ago.
          </p>
          {summary && (
            <div role="status">
              {summary.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
        Portcove contacts SteamGridDB only when you use Find on SteamGridDB, or when you choose
        Check SteamGridDB images: to search, list a game's images, show their previews, download the
        image you choose, or check whether your chosen images are still listed. Those requests send
        the name you search for, SteamGridDB game and image IDs, and ordinary connection details
        such as your IP address. Your key goes only to SteamGridDB's API, never to its image server.
        Your files, game paths and library stay on this device.
      </p>
      {message && <p role="status">{message}</p>}
      {(error ?? current?.error) && <p role="alert">{error ?? current?.error}</p>}
    </SettingsRow>
  );
}
