import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
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
  const [problem, setProblem] = useState<string | undefined>();
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
          setProblem(failurePresentation(value)?.summary ?? "The setting could not be read.");
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
        setProblem(failurePresentation(value)?.summary ?? "The setting could not be saved.");
    } finally {
      if (request.current === current) setSaving(false);
    }
  };
  return (
    <SettingsRow data-focus-group>
      <div className="grid gap-2">
        <h3 className="text-base font-semibold">Snapshot saved data before version changes</h3>
        <p className="text-sm text-pc-muted-foreground">
          Before an update installs, a saved update is activated, or you restore a previous version,
          Portcove copies a game&rsquo;s managed saves and settings so you can restore them if the
          new version misreads them. It skips games whose saves live outside Portcove and games with
          no saved data yet, and if a snapshot cannot be taken the version change stops. Portcove
          keeps the newest five automatic snapshots for each game and never removes the ones you
          take yourself. This applies to every game in this library, starting with the next version
          change.
        </p>
        <label htmlFor={controlId} className="flex items-center gap-2 text-sm">
          <Checkbox
            id={controlId}
            checked={enabled ?? false}
            disabled={enabled === undefined || saving}
            onCheckedChange={(value) => void change(value)}
          />
          Snapshot saved data before each version change
        </label>
        {problem && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert">{problem}</p>
            {enabled === undefined && (
              <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </SettingsRow>
  );
}
