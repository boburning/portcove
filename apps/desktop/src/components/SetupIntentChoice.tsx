import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import type { PortIntent, PortIntentMode } from "../types";
import { useAppTranslation } from "../localization";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { requestStandingSetup } from "../features/game-file-discovery/use-standing-setup";

const choices: readonly PortIntentMode[] = [
  "discover_only",
  "notify",
  "set_up_when_ready",
  "ignored",
];

/** Each choice's label and explanation by static key, so extraction keeps every form. */
function choiceCopy(t: TFunction<"gameFiles">, mode: PortIntentMode) {
  switch (mode) {
    case "discover_only":
      return { label: t("intent.discoverOnly.label"), detail: t("intent.discoverOnly.detail") };
    case "notify":
      return { label: t("intent.notify.label"), detail: t("intent.notify.detail") };
    case "set_up_when_ready":
      return { label: t("intent.setUpWhenReady.label"), detail: t("intent.setUpWhenReady.detail") };
    case "ignored":
      return { label: t("intent.ignored.label"), detail: t("intent.ignored.detail") };
  }
}

/**
 * The player's remembered choice for one game. Core stores it and decides
 * readiness; this control only shows and changes the choice.
 */
export function SetupIntentChoice({
  portId,
  generation,
  installed = false,
}: {
  portId: string;
  generation: number;
  installed?: boolean | undefined;
}) {
  const { t } = useAppTranslation("gameFiles");
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
      if (mode === "set_up_when_ready") requestStandingSetup();
    } catch (value) {
      if (owner.current === expected) setError(errorText(value));
    } finally {
      if (owner.current === expected) setBusy(false);
    }
  };

  return (
    <fieldset className="mt-6 grid gap-2 text-sm" aria-busy={busy || !loaded}>
      <legend className="text-base">{t("intent.legend")}</legend>
      {choices
        .map((mode) => ({ mode, ...choiceCopy(t, mode) }))
        .map((choice) => (
          <label key={choice.mode} className="flex cursor-pointer items-start gap-3">
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
      {intent?.explicitly_uninstalled_at && !installed && (
        <div>
          <p>{t("intent.uninstalled")}</p>
          {current !== "discover_only" && current !== "ignored" && (
            <Button
              data-focusable
              variant="outline"
              disabled={busy}
              onClick={() => void choose(current)}
            >
              {t("intent.useAgain", { choice: choiceCopy(t, current).label })}
            </Button>
          )}
        </div>
      )}
      {intent?.failure && (
        <p>
          {/* Core's failure text is exact, never interpolated. */}
          <Trans
            t={t}
            i18nKey="intent.failed"
            components={{ reason: <bdi>{intent.failure}</bdi> }}
          />
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
