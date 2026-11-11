import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { PortIntent, PortIntentMode } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";

const choices: { mode: PortIntentMode; label: string; detail: string }[] = [
  {
    mode: "discover_only",
    label: "Only show it in discovery",
    detail: "Portcove doesn't notify you about this game or install it.",
  },
  {
    mode: "notify",
    label: "Tell me when it's ready",
    detail: "You're told once when it can be installed. Nothing is installed.",
  },
  {
    mode: "set_up_when_ready",
    label: "Set it up when it's ready",
    detail:
      "Portcove installs it without asking again once its files and requirements are ready. It never starts the game. Choose another option to stop.",
  },
  {
    mode: "ignored",
    label: "Ignore this game",
    detail: "Portcove doesn't suggest, notify about or set up this game.",
  },
];

/**
 * The player's remembered choice for one game. Core stores it and decides
 * readiness; this control only shows and changes the choice.
 */
export function SetupIntentChoice({ portId, generation }: { portId: string; generation: number }) {
  const name = useId();
  const [intent, setIntent] = useState<PortIntent>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const owner = useRef(generation);
  useEffect(() => {
    owner.current = generation;
  }, [generation]);

  useEffect(() => {
    const expected = generation;
    desktopApi
      .portIntents(expected)
      .then((intents) => {
        if (owner.current !== expected) return;
        setIntent(intents.find((candidate) => candidate.port_id === portId));
        setLoaded(true);
      })
      .catch((value: unknown) => {
        if (owner.current === expected) setError(errorText(value));
      });
  }, [generation, portId]);

  const current: PortIntentMode = intent?.mode ?? "discover_only";
  const choose = async (mode: PortIntentMode) => {
    const expected = generation;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await desktopApi.setPortIntent(portId, mode, expected);
      if (owner.current === expected) setIntent(saved);
    } catch (value) {
      if (owner.current === expected) setError(errorText(value));
    } finally {
      if (owner.current === expected) setBusy(false);
    }
  };

  return (
    <fieldset className="mt-6 grid gap-2 text-sm" aria-busy={busy || !loaded}>
      <legend className="text-base">When this game's files are ready</legend>
      {choices.map((choice) => (
        <label
          key={choice.mode}
          className="flex cursor-pointer items-start gap-3"
          aria-label={choice.label}
        >
          <input
            aria-label={choice.label}
            aria-describedby={`${name}-${choice.mode}`}
            type="radio"
            name={name}
            value={choice.mode}
            checked={current === choice.mode}
            disabled={!loaded || busy}
            onChange={() => void choose(choice.mode)}
          />
          <span>
            <strong>{choice.label}</strong>
            <span id={`${name}-${choice.mode}`} className="block text-pc-muted-foreground">
              {choice.detail}
            </span>
          </span>
        </label>
      ))}
      {intent?.explicitly_uninstalled_at && (
        <div>
          <p>
            You uninstalled this game, so Portcove won't set it up or notify you about it until you
            choose an option again.
          </p>
          {current !== "discover_only" && current !== "ignored" && (
            <Button
              data-focusable
              variant="outline"
              disabled={busy}
              onClick={() => void choose(current)}
            >
              Use “{choices.find((choice) => choice.mode === current)?.label}” again
            </Button>
          )}
        </div>
      )}
      {intent?.failure && (
        <p>
          The last automatic setup didn't finish: {intent.failure}. Portcove tries again when the
          game's files, catalog or requirements change.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
