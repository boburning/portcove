import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import type {
  GameFileRoot,
  PortDefinition,
  RootSetupConsent,
  RootSetupEnrollment,
  SourceRecord,
} from "../types";
import { errorText } from "../view-model";
import {
  onStandingSetupPass,
  requestStandingSetup,
} from "../features/game-file-discovery/use-standing-setup";

type Choice = RootSetupEnrollment | "off";

/** Core stops retrying a game at this many failures with the same plan or file. */
const maxAttempts = 3;

const choices: { value: Choice; label: string; detail: string }[] = [
  {
    value: "off",
    label: "Don't set up games from this folder automatically",
    detail: "Portcove only shows what it finds here.",
  },
  {
    value: "existing_and_future",
    label: "Set up eligible games already here and any added later",
    detail:
      "Portcove installs each eligible game once its files and requirements are ready. It never starts a game.",
  },
  {
    value: "future_only",
    label: "Only set up games added later",
    detail:
      "Portcove remembers every file in this folder now and leaves those games alone, even if it recognizes them later.",
  },
];

/**
 * The player's automatic-setup choice for one saved folder. Core stores the
 * consent and its enrollment boundary, decides eligibility and installs;
 * this control only shows and changes the choice.
 */
export function FolderSetupChoice({
  root,
  generation,
  ports,
  candidates,
  disabled,
}: {
  root: GameFileRoot;
  generation: number;
  ports: PortDefinition[];
  /** Matched files from the last scan, used to offer implementation choices. */
  candidates: SourceRecord[];
  disabled?: boolean | undefined;
}) {
  const name = useId();
  const [consent, setConsent] = useState<RootSetupConsent | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const owner = useRef(generation);
  useEffect(() => {
    owner.current = generation;
  }, [generation]);

  useEffect(() => {
    const expected = generation;
    const load = () =>
      desktopApi
        .rootSetupConsents(expected)
        .then((consents) => {
          if (owner.current === expected)
            setConsent(consents.find((candidate) => candidate.root_id === root.id) ?? null);
        })
        .catch((value: unknown) => {
          if (owner.current === expected) setError(errorText(value));
        });
    void load();
    // A pass may record failures; show them without reopening the folder.
    return onStandingSetupPass(() => void load());
  }, [generation, root.id]);

  const save = async (change: () => Promise<RootSetupConsent | null>) => {
    const expected = generation;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await change();
      if (owner.current === expected) setConsent(saved);
      if (saved) requestStandingSetup();
    } catch (value) {
      if (owner.current === expected) setError(errorText(value));
    } finally {
      if (owner.current === expected) setBusy(false);
    }
  };

  const current: Choice = consent?.enrollment ?? "off";
  // Files here that more than one game can use need an explicit choice.
  const shared = [...new Set(candidates.map((candidate) => candidate.profile_id))]
    .map((profileId) => ({
      profileId,
      games: ports.filter((port) => port.source_profile === profileId),
    }))
    .filter((profile) => profile.games.length > 1);

  return (
    <fieldset className="mt-3 grid gap-2 text-sm" aria-busy={busy || consent === undefined}>
      <legend>Automatic setup from this folder</legend>
      {choices.map((choice) => (
        <label
          key={choice.value}
          className="flex cursor-pointer items-start gap-3"
          aria-label={choice.label}
        >
          <input
            aria-describedby={`${name}-${choice.value}`}
            type="radio"
            name={name}
            value={choice.value}
            checked={current === choice.value}
            disabled={consent === undefined || busy || disabled}
            onChange={() =>
              void save(() =>
                desktopApi.setRootSetupConsent(
                  root.id,
                  choice.value === "off" ? null : choice.value,
                  generation,
                ),
              )
            }
          />
          <span>
            <strong>{choice.label}</strong>
            <span id={`${name}-${choice.value}`} className="block text-pc-muted-foreground">
              {choice.detail}
            </span>
          </span>
        </label>
      ))}
      {consent &&
        shared.map(({ profileId, games }) => {
          const chosen = consent.implementations?.find(
            (choice) => choice.profile_id === profileId,
          )?.port_id;
          return (
            <label key={profileId} className="grid gap-1">
              <span>
                More than one game can use some files here. Choose which one to set up; until you
                do, Portcove waits.
              </span>
              <select
                value={chosen ?? ""}
                disabled={busy || disabled}
                onChange={(event) => {
                  const portId = event.target.value;
                  if (portId)
                    void save(() =>
                      desktopApi.setRootSetupImplementation(root.id, profileId, portId, generation),
                    );
                }}
              >
                <option value="">Choose a game</option>
                {games.map((game) => (
                  <option key={game.id} value={game.id}>
                    {game.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      {consent?.failures
        ?.filter((failure) => failure.attempts >= maxAttempts)
        .map((failure) => (
          <p key={failure.port_id}>
            {ports.find((port) => port.id === failure.port_id)?.name ?? failure.port_id} didn't
            finish setting up after {failure.attempts} tries: {failure.reason}. Portcove tries again
            when the game's files or setup change.
          </p>
        ))}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
