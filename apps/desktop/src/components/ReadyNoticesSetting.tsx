import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { announceReadyNoticePreferenceChange } from "../features/game-file-discovery/use-standing-setup";
import { useAppTranslation } from "../localization";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

/**
 * One switch for ready-game notices. Core owns the value and decides what a
 * notice is; this shows what Core reports and writes the player's choice back.
 * It never changes a game's choice or automatic setup.
 */
export function ReadyNoticesSetting({
  generation,
  load = desktopApi.readyNoticesEnabled,
  save = desktopApi.setReadyNoticesEnabled,
}: {
  generation: number;
  load?: (generation: number) => Promise<boolean>;
  save?: (enabled: boolean, generation: number) => Promise<boolean>;
}) {
  // `undefined` until Core has answered; a stale answer for another library
  // generation is never shown.
  const [state, setState] = useState<{ generation: number; enabled: boolean } | undefined>();
  const [problem, setProblem] = useState<
    { action: "read" | "save"; summary: string | undefined } | undefined
  >();
  const { t } = useAppTranslation("gameFiles");
  // The generation a save is in flight for; a save for another library never disables this one.
  const [savingGeneration, setSavingGeneration] = useState<number | undefined>();
  const saving = savingGeneration === generation;
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const controlId = useId();
  useEffect(() => {
    const current = ++request.current;
    load(generation).then(
      (enabled) => {
        if (request.current === current) {
          setProblem(undefined);
          setState({ generation, enabled });
        }
      },
      (value) => {
        if (request.current === current)
          setProblem({ action: "read", summary: failurePresentation(value)?.summary });
      },
    );
    return () => {
      request.current += 1;
    };
  }, [generation, load, attempt]);
  const enabled = state?.generation === generation ? state.enabled : undefined;
  const change = async (next: boolean) => {
    const current = ++request.current;
    setSavingGeneration(generation);
    setProblem(undefined);
    try {
      const stored = await save(next, generation);
      if (request.current === current) {
        setState({ generation, enabled: stored });
        announceReadyNoticePreferenceChange();
      }
    } catch (value) {
      if (request.current === current)
        setProblem({ action: "save", summary: failurePresentation(value)?.summary });
    } finally {
      setSavingGeneration((value) => (value === generation ? undefined : value));
    }
  };
  return (
    <div className="grid gap-2" data-focus-group>
      <h3 className="text-base font-semibold">{t("readyNotices.heading")}</h3>
      <p className="text-sm text-pc-muted-foreground">{t("readyNotices.description")}</p>
      <label htmlFor={controlId} className="flex items-center gap-2 text-sm">
        <Checkbox
          id={controlId}
          checked={enabled ?? false}
          disabled={enabled === undefined || saving}
          onCheckedChange={(value) => void change(value)}
        />
        {t("readyNotices.control")}
      </label>
      {problem && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert">
            {problem.summary ??
              (problem.action === "read"
                ? t("readyNotices.readFailed")
                : t("readyNotices.saveFailed"))}
          </p>
          {enabled === undefined && (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {t("readyNotices.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
