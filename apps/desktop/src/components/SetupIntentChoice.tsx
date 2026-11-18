import type { TFunction } from "i18next";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

type Props = {
  portId: string;
  generation: number;
  installed?: boolean | undefined;
};

/**
 * The player's remembered choice for one game. Core stores it and decides
 * readiness; this control only shows and changes the choice.
 */
export function SetupIntentChoice(props: Props) {
  return (
    <BoundSetupIntentChoice key={JSON.stringify([props.portId, props.generation])} {...props} />
  );
}

function BoundSetupIntentChoice({ portId, generation, installed = false }: Props) {
  const { t } = useAppTranslation("gameFiles");
  const name = useId();
  const [intent, setIntent] = useState<PortIntent>();
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [readRequest, setReadRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // This context owns serialized reads and writes until its bound view unmounts.
  const owner = useRef({ active: true, pending: true });
  useLayoutEffect(() => {
    const current = { active: true, pending: true };
    owner.current = current;
    return () => {
      current.active = false;
    };
  }, []);

  useEffect(() => {
    const scope = owner.current;
    scope.pending = true;
    desktopApi
      .portIntents(generation)
      .then((intents) => {
        if (!scope.active) return;
        setIntent(intents.find((candidate) => candidate.port_id === portId));
        setLoaded(true);
        setReadFailed(false);
      })
      .catch((value: unknown) => {
        if (!scope.active) return;
        setReadFailed(true);
        setError(errorText(value));
      })
      .finally(() => {
        if (!scope.active) return;
        scope.pending = false;
        setReading(false);
      });
  }, [generation, portId, readRequest]);

  const reread = () => {
    const scope = owner.current;
    if (!scope.active || scope.pending) return;
    scope.pending = true;
    setReading(true);
    setError(undefined);
    setReadRequest((request) => request + 1);
  };

  const current: PortIntentMode = intent?.mode ?? "discover_only";
  const controlsDisabled = !loaded || reading || readFailed || busy;
  const choose = async (mode: PortIntentMode) => {
    const scope = owner.current;
    if (!scope.active || scope.pending || !loaded || readFailed) return;
    scope.pending = true;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await desktopApi.setPortIntent(portId, mode, generation);
      if (scope.active) setIntent(saved);
      if (mode === "set_up_when_ready") requestStandingSetup();
    } catch (value) {
      if (scope.active) setError(errorText(value));
    } finally {
      scope.pending = false;
      if (scope.active) setBusy(false);
    }
  };

  return (
    <fieldset className="mt-6 grid min-w-0 gap-2 text-sm wrap-anywhere" aria-busy={busy || reading}>
      <legend className="text-base">{t("intent.legend")}</legend>
      {choices
        .map((mode) => ({ mode, ...choiceCopy(t, mode) }))
        .map((choice) => (
          <label key={choice.mode} className="flex cursor-pointer items-start gap-3">
            <input
              className="shrink-0"
              aria-label={choice.label}
              aria-describedby={`${name}-${choice.mode}`}
              type="radio"
              name={name}
              value={choice.mode}
              checked={loaded && current === choice.mode}
              disabled={controlsDisabled}
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
      {!loaded && reading && !readFailed && <p role="status">{t("intent.reading")}</p>}
      {intent?.explicitly_uninstalled_at && !installed && (
        <div>
          <p>{t("intent.uninstalled")}</p>
          {current !== "discover_only" && current !== "ignored" && (
            <Button
              data-focusable
              variant="outline"
              disabled={controlsDisabled}
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
      {(readFailed || readRequest > 0) && (
        <Button
          data-focusable
          variant="outline"
          className="justify-self-start"
          disabled={reading || busy}
          focusableWhenDisabled={reading || busy}
          onClick={reread}
        >
          {reading ? t("intent.reading") : t("intent.readAgain")}
        </Button>
      )}
    </fieldset>
  );
}
