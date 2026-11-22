import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
function useAutomaticSnapshots(
  generation: number,
  load = desktopApi.automaticSnapshots,
  save = desktopApi.setAutomaticSnapshots,
) {
  // `undefined` until Core has answered; a stale answer for another library
  // generation is never shown.
  const [state, setState] = useState<{ generation: number; enabled: boolean } | undefined>();
  // Core's own summary when it gave one; otherwise which action failed, so the
  // fallback is translated at render and follows a live language change.
  const [problem, setProblem] = useState<
    | ({
        generation: number;
        summary: string | undefined;
      } & ({ action: "read" } | { action: "save"; attempted: boolean }))
    | undefined
  >();
  const [savingGeneration, setSavingGeneration] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const [requested, setRequested] = useState(false);
  const requestRead = useCallback(() => setRequested(true), []);
  useEffect(() => {
    if (!requested) return;
    const current = ++request.current;
    load(generation).then(
      (enabled) => {
        if (request.current === current) {
          setProblem((previous) =>
            previous?.generation === generation &&
            previous.action === "save" &&
            previous.attempted !== enabled
              ? previous
              : undefined,
          );
          setState({ generation, enabled });
        }
      },
      (value) => {
        if (request.current === current)
          setProblem({ generation, action: "read", summary: failurePresentation(value)?.summary });
      },
    );
    return () => {
      request.current += 1;
    };
  }, [generation, load, attempt, requested]);
  const enabled = state?.generation === generation ? state.enabled : undefined;
  const change = async (next: boolean) => {
    const current = ++request.current;
    setSavingGeneration(generation);
    setProblem(undefined);
    try {
      const stored = await save(next, generation);
      if (request.current === current) setState({ generation, enabled: stored });
    } catch (value) {
      if (request.current === current) {
        // A lost reply can follow a committed write. Discard the old value and
        // read Core again without repeating the player's requested change.
        setState(undefined);
        setProblem({
          generation,
          action: "save",
          attempted: next,
          summary: failurePresentation(value)?.summary,
        });
        setAttempt((attempt) => attempt + 1);
      }
    } finally {
      if (request.current === current) setSavingGeneration(undefined);
    }
  };
  return {
    generation,
    enabled,
    requestRead,
    problem: problem?.generation === generation ? problem : undefined,
    saving: savingGeneration === generation,
    change,
    retry: () => setAttempt((value) => value + 1),
  };
}

type AutomaticSnapshotsProps = {
  generation: number;
  load?: ((generation: number) => Promise<boolean>) | undefined;
  save?: ((enabled: boolean, generation: number) => Promise<boolean>) | undefined;
};
const AutomaticSnapshotsContext = createContext<ReturnType<typeof useAutomaticSnapshots> | null>(
  null,
);

export function AutomaticSnapshotsProvider({
  generation,
  load,
  save,
  children,
}: AutomaticSnapshotsProps & { children: ReactNode }) {
  const policy = useAutomaticSnapshots(generation, load, save);
  return <AutomaticSnapshotsContext value={policy}>{children}</AutomaticSnapshotsContext>;
}

function AutomaticSnapshotsScope({
  children,
  ...props
}: AutomaticSnapshotsProps & { children: ReactNode }) {
  const current = useContext(AutomaticSnapshotsContext);
  if (current?.generation === props.generation && !props.load && !props.save) return children;
  return <AutomaticSnapshotsProvider {...props}>{children}</AutomaticSnapshotsProvider>;
}

function useSnapshotPolicy() {
  const policy = useContext(AutomaticSnapshotsContext);
  const requestRead = policy?.requestRead;
  useEffect(() => requestRead?.(), [requestRead]);
  if (!policy) throw new Error("Automatic snapshot policy requires a library scope");
  return policy;
}

/** Present the library policy separately from coverage and completed backup records. */
export function AutomaticSnapshotsSummary({ generation }: { generation: number }) {
  return (
    <AutomaticSnapshotsScope generation={generation}>
      <SnapshotPolicyStatus />
    </AutomaticSnapshotsScope>
  );
}

function SnapshotPolicyStatus() {
  const { t } = useAppTranslation("backups");
  const { enabled, problem, saving } = useSnapshotPolicy();
  const current = saving ? undefined : enabled;
  return (
    <div className="grid gap-1 text-sm" data-automatic-snapshot-policy>
      <p role="status" className="m-0 font-medium">
        {current === true
          ? t("automaticSnapshots.enabled")
          : current === false
            ? t("automaticSnapshots.disabled")
            : problem
              ? t("automaticSnapshots.unavailable")
              : t("automaticSnapshots.checking")}
      </p>
      {current === true && <p className="m-0">{t("automaticSnapshots.coverage")}</p>}
    </div>
  );
}

export function AutomaticSnapshotsSetting(props: AutomaticSnapshotsProps) {
  return (
    <AutomaticSnapshotsScope {...props}>
      <SnapshotPolicySetting />
    </AutomaticSnapshotsScope>
  );
}

function SnapshotPolicySetting() {
  const { t } = useAppTranslation("backups");
  const { enabled, problem, saving, change, retry } = useSnapshotPolicy();
  const controlId = useId();
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
              <Button variant="outline" onClick={retry}>
                {t("automaticSnapshots.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
    </SettingsRow>
  );
}
