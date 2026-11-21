import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type {
  ArtworkSlot,
  SteamGridDbArtworkRole,
  SteamGridDbCandidate,
  SteamGridDbGame,
  SteamGridDbKeyStatus,
} from "../types";
import { steamGridDbErrorText } from "../steamgriddb-error";
import { SteamGridDbSettings } from "./SteamGridDbSettings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { controlFocus } from "./ui/control-style";

const PAGE = 12;
/** A failed preview is not refetched for this long, across picker remounts. */
const FAILED_PREVIEW_MS = 5 * 60 * 1000;
const PREVIEW_CACHE_LIMIT = 200;
const previews = new Map<string, { image?: string; failedAt?: number }>();
/** Previews pause after SteamGridDB asks Portcove to slow down. */
const previewPause = { until: 0 };

function rememberPreview(url: string, entry: { image?: string; failedAt?: number }) {
  previews.delete(url);
  previews.set(url, entry);
  if (previews.size > PREVIEW_CACHE_LIMIT) previews.delete(previews.keys().next().value!);
}

function retryAfterMs(error: unknown) {
  if (typeof error !== "object" || !error || !("details" in error)) return 0;
  const seconds = Number(
    (error as { details?: Record<string, string> }).details?.retry_after_seconds,
  );
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** The provider role each local slot takes from SteamGridDB. */
const slotRoles: Record<ArtworkSlot, SteamGridDbArtworkRole> = {
  cover: "portrait_cover",
  detail: "hero_banner",
  landscape: "landscape_cover",
  logo: "logo",
};

/** Preview frames follow each role's shape, so wide images are not squeezed. */
const roleAspect: Record<SteamGridDbArtworkRole, string> = {
  portrait_cover: "aspect-[2/3]",
  hero_banner: "aspect-[96/31]",
  landscape_cover: "aspect-[92/43]",
  logo: "aspect-[3/2]",
};

export function steamGridDbRole(slot: ArtworkSlot): SteamGridDbArtworkRole {
  return slotRoles[slot];
}

/**
 * Searches and lists SteamGridDB suggestions for one slot. Every request is
 * player-driven; a newer search or game choice supersedes older results, and
 * the picker never loads a remote image itself (Core supplies local previews).
 */
export function SteamGridDbPicker({
  slot,
  initialTerm,
  disabled,
  selectionPending = false,
  generation,
  active = true,
  choose,
}: {
  slot: ArtworkSlot;
  initialTerm: string;
  disabled: boolean;
  selectionPending?: boolean;
  generation?: number | undefined;
  active?: boolean;
  choose: (gameId: number, candidate: SteamGridDbCandidate) => void;
}) {
  const [status, setStatus] = useState<SteamGridDbKeyStatus>();
  const [readingStatus, setReadingStatus] = useState(true);
  const [statusReadAttempt, setStatusReadAttempt] = useState(0);
  const statusReadPending = useRef(true);
  const [keySetup, setKeySetup] = useState(false);
  const [term, setTerm] = useState(initialTerm);
  const [games, setGames] = useState<SteamGridDbGame[]>();
  const [game, setGame] = useState<SteamGridDbGame>();
  const [candidates, setCandidates] = useState<SteamGridDbCandidate[]>();
  const [shown, setShown] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown }>();
  /** Milliseconds SteamGridDB asked Portcove to wait before another request. */
  const [blockedFor, setBlockedFor] = useState(0);
  const blocked = blockedFor > 0;
  const error = failure && steamGridDbErrorText(failure.error, blocked);
  const request = useRef(0);
  // Steps that remove the focused control move focus to the next useful one.
  const pendingFocus = useRef<"images" | "matches" | "status" | "key-setup">(undefined);
  const backButton = useRef<HTMLButtonElement>(null);
  const matchList = useRef<HTMLUListElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const setupGuidance = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!active || keySetup) return;
    if (pendingFocus.current === "status" && status === undefined) return;
    if (pendingFocus.current === "status" && status !== undefined)
      (status.configured ? searchInput.current : setupGuidance.current)?.focus();
    if (pendingFocus.current === "key-setup") setupButton.current?.focus();
    if (pendingFocus.current === "images" && game) backButton.current?.focus();
    if (pendingFocus.current === "matches" && !game)
      matchList.current?.querySelector<HTMLButtonElement>("button")?.focus();
    pendingFocus.current = undefined;
  }, [game, status, keySetup, active]);
  useEffect(() => {
    if (!blocked) return;
    const timer = setTimeout(() => setBlockedFor(0), blockedFor);
    return () => clearTimeout(timer);
  }, [blocked, blockedFor]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    statusReadPending.current = true;
    const id = ++request.current;
    desktopApi
      .steamGridDbKeyStatus()
      .then((value) => {
        if (mounted.current && id === request.current) setStatus(value);
      })
      .catch((value: unknown) => {
        if (mounted.current && id === request.current) setFailure({ error: value });
      })
      .finally(() => {
        if (!mounted.current || id !== request.current) return;
        statusReadPending.current = false;
        setReadingStatus(false);
      });
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, [statusReadAttempt]);
  const retryStatus = () => {
    if (!mounted.current || statusReadPending.current || status !== undefined) return;
    statusReadPending.current = true;
    pendingFocus.current = "status";
    setReadingStatus(true);
    setFailure(undefined);
    setStatusReadAttempt((attempt) => attempt + 1);
  };

  const run = async <T,>(work: () => Promise<T>, apply: (value: T) => void) => {
    if (!mounted.current || blocked || !status?.configured) return;
    const id = ++request.current;
    setLoading(true);
    setFailure(undefined);
    try {
      const value = await work();
      if (mounted.current && id === request.current) apply(value);
    } catch (value) {
      if (mounted.current && id === request.current) {
        setFailure({ error: value });
        // Honor SteamGridDB's own retry guidance before allowing another request.
        const wait = retryAfterMs(value);
        if (wait > 0) setBlockedFor(wait);
      }
    } finally {
      if (mounted.current && id === request.current) setLoading(false);
    }
  };
  const search = () =>
    void run(
      () => desktopApi.searchSteamGridDbGames(term),
      (found) => {
        setGames(found);
        setGame(undefined);
        setCandidates(undefined);
      },
    );
  const pickGame = (selected: SteamGridDbGame) => {
    if (blocked || !status?.configured) return;
    pendingFocus.current = "images";
    setGame(selected);
    setCandidates(undefined);
    setShown(PAGE);
    void run(
      () => desktopApi.steamGridDbCandidates(selected.id, steamGridDbRole(slot)),
      setCandidates,
    );
  };

  if (status === undefined)
    return (
      <div
        className="steamgriddb-picker mt-3 grid min-w-0 gap-3 wrap-anywhere"
        aria-busy={readingStatus}
      >
        <p role="status">
          {readingStatus ? "Checking SteamGridDB setup…" : "Couldn't check SteamGridDB setup."}
        </p>
        {failure && <p role="alert">{error}</p>}
        {(failure || statusReadAttempt > 0) && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={readingStatus}
            focusableWhenDisabled={readingStatus}
            aria-busy={readingStatus}
            onClick={retryStatus}
          >
            Check setup again
          </Button>
        )}
      </div>
    );
  if (active && keySetup && generation !== undefined)
    return (
      <SteamGridDbSettings
        generation={generation}
        keySetup={{
          onCancel: () => {
            pendingFocus.current = "key-setup";
            setKeySetup(false);
          },
          onConfigured: (configured) => {
            pendingFocus.current = "status";
            setStatus(configured);
            setKeySetup(false);
          },
        }}
      />
    );
  if (!status.configured)
    return (
      <div className="mt-3 grid gap-2">
        <p ref={setupGuidance} tabIndex={-1} className={controlFocus}>
          To find images on SteamGridDB, add your own SteamGridDB API key. You can manage the saved
          key in Settings, under Integrations.
        </p>
        {generation !== undefined && (
          <Button
            ref={setupButton}
            data-focusable
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={selectionPending}
            onClick={() => setKeySetup(true)}
          >
            Set up SteamGridDB key
          </Button>
        )}
      </div>
    );
  return (
    <div className="steamgriddb-picker mt-3 grid min-w-0 gap-3 wrap-anywhere" aria-busy={loading}>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectionPending && term.trim()) search();
        }}
      >
        <label className="sr-only" htmlFor={`steamgriddb-search-${slot}`}>
          Game name to search on SteamGridDB
        </label>
        <Input
          ref={searchInput}
          id={`steamgriddb-search-${slot}`}
          data-focusable
          className="flex-1"
          value={term}
          maxLength={120}
          disabled={selectionPending}
          onChange={(event) => setTerm(event.target.value)}
        />
        <Button
          data-focusable
          variant="outline"
          size="sm"
          type="submit"
          disabled={selectionPending || loading || blocked || !term.trim()}
        >
          Search
        </Button>
      </form>
      {games && games.length === 0 && (
        <p role="status">No SteamGridDB games matched. Try a shorter or different name.</p>
      )}
      {games && games.length > 0 && !game && (
        <div role="group" aria-label="SteamGridDB matches">
          <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            Matches are suggestions. Choose the game whose artwork you want.
          </p>
          <ul ref={matchList} className="grid list-none gap-1 p-0">
            {games.map((match) => (
              <li key={match.id}>
                <Button
                  data-focusable
                  variant="ghost"
                  size="sm"
                  disabled={selectionPending || blocked}
                  focusableWhenDisabled={blocked && !selectionPending}
                  onClick={() => pickGame(match)}
                >
                  {match.name}
                  {match.verified ? " (verified)" : ""}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {game && (
        <div role="group" aria-label={`SteamGridDB images for ${game.name}`}>
          <div className="flex items-center justify-between gap-2">
            <strong>{game.name}</strong>
            <Button
              ref={backButton}
              data-focusable
              variant="link"
              size="sm"
              disabled={selectionPending}
              onClick={() => {
                // Supersede any listing still in flight for the abandoned game.
                request.current += 1;
                pendingFocus.current = "matches";
                setLoading(false);
                if (!blocked) setFailure(undefined);
                setGame(undefined);
                setCandidates(undefined);
              }}
            >
              Back to matches
            </Button>
          </div>
          {candidates && candidates.length === 0 && (
            <p role="status">
              No suitable still PNG or JPEG images were found for this game. Try another match.
            </p>
          )}
          {candidates && candidates.length > 0 && (
            <>
              <ul className="mt-2 grid list-none grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3 p-0">
                {candidates.slice(0, shown).map((candidate) => (
                  <li key={candidate.id}>
                    <CandidateButton
                      candidate={candidate}
                      disabled={disabled || loading}
                      choose={() => choose(game.id, candidate)}
                    />
                  </li>
                ))}
              </ul>
              {candidates.length > shown && (
                <Button
                  data-focusable
                  variant="outline"
                  size="sm"
                  disabled={selectionPending}
                  onClick={() => setShown((count) => count + PAGE)}
                >
                  Show more images
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {loading && <p role="status">Contacting SteamGridDB…</p>}
      {error && (
        <div>
          <p role="alert">{error}</p>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={selectionPending || loading || blocked}
            onClick={() => (game ? pickGame(game) : term.trim() && search())}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function CandidateButton({
  candidate,
  disabled,
  choose,
}: {
  candidate: SteamGridDbCandidate;
  disabled: boolean;
  choose: () => void;
}) {
  const [cached] = useState(() => previews.get(candidate.thumb));
  const [preview, setPreview] = useState<string | undefined>(cached?.image);
  // A remembered failure shows immediately; the effect decides whether it expired.
  const [failed, setFailed] = useState(cached?.failedAt !== undefined);
  useEffect(() => {
    if (preview) return;
    const entry = previews.get(candidate.thumb);
    const now = Date.now();
    if (entry?.failedAt !== undefined && now - entry.failedAt < FAILED_PREVIEW_MS) return;
    const live = { current: true };
    if (previewPause.until > now) {
      // A paused preview is not a failure: it is not remembered, so it loads
      // again once SteamGridDB's retry time has passed.
      void Promise.resolve().then(() => live.current && setFailed(true));
      return () => {
        live.current = false;
      };
    }
    desktopApi
      .steamGridDbPreview(candidate.thumb)
      .then((value) => {
        const image = `data:image/png;base64,${value.png_base64}`;
        rememberPreview(candidate.thumb, { image });
        if (live.current) setPreview(image);
      })
      .catch((value: unknown) => {
        const wait = retryAfterMs(value);
        if (wait > 0) previewPause.until = Date.now() + wait;
        rememberPreview(candidate.thumb, { failedAt: Date.now() });
        if (live.current) setFailed(true);
      });
    return () => {
      live.current = false;
    };
  }, [candidate.thumb, preview]);
  const label = `Use image by ${candidate.author.name}, ${candidate.width} by ${candidate.height}`;
  return (
    <Button
      data-focusable
      variant="outline"
      className="grid h-auto w-full gap-1 p-2 text-left"
      aria-label={label}
      disabled={disabled}
      onClick={choose}
    >
      <span
        className={`bg-pc-subtle grid ${roleAspect[candidate.role]} place-items-center overflow-hidden rounded-pc-sm`}
      >
        {preview ? (
          <img className="max-h-full max-w-full object-contain" src={preview} alt="" />
        ) : (
          <small>{failed ? "Preview unavailable" : "Loading preview…"}</small>
        )}
      </span>
      <small className="truncate">by {candidate.author.name}</small>
      <small className="text-[var(--color-text-muted)]">
        {candidate.width} × {candidate.height}
      </small>
    </Button>
  );
}
