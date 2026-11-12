import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { SettingsRow } from "./ui/patterns";

/**
 * Per-library switch for the snapshot Portcove takes before an update, an
 * activation or a rollback. Core owns the value; this shows what Core reports
 * and writes the player's choice back.
 */
export function AutomaticSnapshotsSetting({
  generation,
  load = desktopApi.automaticSnapshots,
  save = desktopApi.setAutomaticSnapshots,
}: {
  generation: number;
  load?: (generation: number) => Promise<boolean>;
  save?: (enabled: boolean, generation: number) => Promise<boolean>;
}) {
  // `undefined` until Core has answered; a stale answer for another library
  // generation is never shown.
  const [state, setState] = useState<{ generation: number; enabled: boolean } | undefined>();
  // Core's own summary when it gave one; otherwise which action failed, so the
  // fallback is translated at render and follows a live language change.
  const [problem, setProblem] = useState<
    { action: "read" | "save"; summary: string | undefined } | undefined
  >();
  const { t } = useAppTranslation("backups");
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    setProblem(undefined);
    try {
      const stored = await save(next, generation);
      if (request.current === current) setState({ generation, enabled: stored });
    } catch (value) {
      if (request.current === current)
        setProblem({ action: "save", summary: failurePresentation(value)?.summary });
    } finally {
      if (request.current === current) setSaving(false);
    }
  };
  return (
    <SettingsRow data-focus-group>
      <div className="grid gap-2">
        <h3 className="text-base font-semibold">{t("automaticSnapshots.heading")}</h3>
        <p className="text-sm text-pc-muted-foreground">{t("automaticSnapshots.description")}</p>
        <label htmlFor={controlId} className="flex items-center gap-2 text-sm">
          <Checkbox
            id={controlId}
            checked={enabled ?? false}
            disabled={enabled === undefined || saving}
            onCheckedChange={(value) => void change(value)}
          />
          {t("automaticSnapshots.control")}
        </label>
        {problem && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert">
              {problem.summary ??
                (problem.action === "read"
                  ? t("automaticSnapshots.readFailed")
                  : t("automaticSnapshots.saveFailed"))}
            </p>
            {enabled === undefined && (
              <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                {t("automaticSnapshots.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
    </SettingsRow>
  );
}
