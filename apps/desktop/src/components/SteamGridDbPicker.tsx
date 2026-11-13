import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type {
  ArtworkSlot,
  DestinationArtworkRole,
  SteamGridDbCandidate,
  SteamGridDbGame,
  SteamGridDbKeyStatus,
} from "../types";
import { errorText, failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const PAGE = 12;

/** The destination role each local slot takes from SteamGridDB. */
export function steamGridDbRole(slot: ArtworkSlot): DestinationArtworkRole {
  return slot === "cover" ? "portrait_cover" : "hero_banner";
}

/**
 * SteamGridDB messages are written for players; generic presentation summaries
 * would hide which provider step failed. Rate limits keep their retry time.
 */
export function steamGridDbErrorText(error: unknown) {
  // A device-level cause (such as no secure credential store) has its own
  // player summary; the provider message would only repeat technical detail.
  const presentation = failurePresentation(error);
  if (presentation?.presentation_key.startsWith("credential_store_")) return presentation.summary;
  if (typeof error === "object" && error && "message" in error) {
    const value = error as { message: unknown; details?: Record<string, string> };
    const seconds = value.details?.retry_after_seconds;
    const message = String(value.message);
    return seconds ? `${message}. Try again in ${seconds} seconds.` : message;
  }
  return errorText(error);
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
  choose,
}: {
  slot: ArtworkSlot;
  initialTerm: string;
  disabled: boolean;
  choose: (gameId: number, candidate: SteamGridDbCandidate) => void;
}) {
  const [status, setStatus] = useState<SteamGridDbKeyStatus>();
  const [term, setTerm] = useState(initialTerm);
  const [games, setGames] = useState<SteamGridDbGame[]>();
  const [game, setGame] = useState<SteamGridDbGame>();
  const [candidates, setCandidates] = useState<SteamGridDbCandidate[]>();
  const [shown, setShown] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    desktopApi
      .steamGridDbKeyStatus()
      .then((value) => mounted.current && setStatus(value))
      .catch((value: unknown) => mounted.current && setError(steamGridDbErrorText(value)));
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  const run = async <T,>(work: () => Promise<T>, apply: (value: T) => void) => {
    const id = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const value = await work();
      if (mounted.current && id === request.current) apply(value);
    } catch (value) {
      if (mounted.current && id === request.current) setError(steamGridDbErrorText(value));
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
    setGame(selected);
    setCandidates(undefined);
    setShown(PAGE);
    void run(
      () => desktopApi.steamGridDbCandidates(selected.id, steamGridDbRole(slot)),
      setCandidates,
    );
  };

  if (status === undefined && !error) return <p role="status">Checking SteamGridDB setup…</p>;
  if (status && !status.configured)
    return (
      <p>
        To find images on SteamGridDB, add your own SteamGridDB API key in Settings, under
        Integrations.
      </p>
    );
  return (
    <div className="steamgriddb-picker mt-3 grid gap-3" aria-busy={loading}>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (term.trim()) search();
        }}
      >
        <label className="sr-only" htmlFor={`steamgriddb-search-${slot}`}>
          Game name to search on SteamGridDB
        </label>
        <Input
          id={`steamgriddb-search-${slot}`}
          data-focusable
          className="flex-1"
          value={term}
          maxLength={120}
          onChange={(event) => setTerm(event.target.value)}
        />
        <Button
          data-focusable
          variant="outline"
          size="sm"
          type="submit"
          disabled={loading || !term.trim()}
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
          <ul className="grid gap-1">
            {games.map((match) => (
              <li key={match.id}>
                <Button data-focusable variant="ghost" size="sm" onClick={() => pickGame(match)}>
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
              data-focusable
              variant="link"
              size="sm"
              onClick={() => {
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
              <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
                {candidates.slice(0, shown).map((candidate) => (
                  <li key={candidate.id}>
                    <CandidateButton
                      candidate={candidate}
                      disabled={disabled}
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
            disabled={loading}
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
  const [preview, setPreview] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    desktopApi
      .steamGridDbPreview(candidate.thumb)
      .then((value) => current && setPreview(`data:image/png;base64,${value.png_base64}`))
      // A failed preview is not retried while this list is shown.
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [candidate.thumb]);
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
      <span className="bg-pc-subtle grid aspect-[2/3] place-items-center overflow-hidden rounded-pc-sm">
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
