import { useCallback, useEffect, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import { desktopApi } from "../api";
import { pickSourcePath, type SourcePickerPurpose } from "../file-picker";
import type {
  HostToolStatus,
  SourceImportMode,
  SourceImportPlan,
  SourceIntakeInspection,
  SourceProfile,
} from "../types";
import { errorText, isCancellation } from "../view-model";
import { SourceIdentityPanel } from "./SourceIdentity";
import {
  SourceImportReview,
  sourceImportModePresentation,
  sourceImportNotice,
} from "./SourceDiscovery";
import { HostToolRow, type HostToolActions } from "./Chrome";
import { Icon, NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export interface SourceIntakeRequest {
  portId: string;
  portName: string;
  profile: SourceProfile;
  purpose: SourcePickerPurpose;
  paths: string[];
}

interface SourceIntakeDialogProps {
  request: SourceIntakeRequest;
  close: () => void;
  onAdded?: () => Promise<unknown>;
  openEvidence?: (evidenceId: string) => void;
  hostTools?: HostToolStatus[];
  hostToolActions?: HostToolActions;
}

function sourceIntakeCopy(purpose: SourcePickerPurpose) {
  if (purpose === "bios")
    return {
      eyebrow: "BIOS FILE CHECK",
      title: (portName: string) => `Check BIOS for ${portName}`,
      description: "Check this BIOS file for the game. Checking won't change the file.",
      checking: "Checking BIOS file…",
      choose: "Choose BIOS file to check",
      resultLabel: "BIOS file check result",
      unchanged: "Your selected BIOS file remains unchanged.",
      addLabel: "Add checked BIOS file",
      addExplanation: "Choose how to add this BIOS file.",
    };
  return {
    eyebrow: "GAME FILE CHECK",
    title: (portName: string) => `Check files for ${portName}`,
    description: "Check these files for this game. Checking won't change them.",
    checking: "Checking game files…",
    choose: "Choose game files to check",
    resultLabel: "Game file check result",
    unchanged: "Your selected game files remain unchanged.",
    addLabel: "Add checked game files",
    addExplanation: "Choose how to add these files.",
  };
}

export function SourceIntakeDialog(props: SourceIntakeDialogProps) {
  const { request } = props;
  return (
    <SourceIntakeSession
      key={`${request.portId}:${request.profile.id}:${request.purpose}:${JSON.stringify(request.paths)}`}
      {...props}
    />
  );
}

function SourceIntakeSession({
  request,
  close,
  onAdded,
  openEvidence,
  hostTools = [],
  hostToolActions,
}: SourceIntakeDialogProps) {
  const copy = sourceIntakeCopy(request.purpose);
  const [result, setResult] = useState<SourceIntakeInspection>();
  const [plan, setPlan] = useState<SourceImportPlan>();
  const [busy, setBusy] = useState(request.paths.length > 0 ? copy.checking : "");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedPaths, setSelectedPaths] = useState(request.paths);
  const selectedPathsRef = useRef(request.paths);
  const intent = useRef(0);
  const dismiss = () => {
    if (!busy) close();
  };

  const loadInspection = useCallback(
    async (paths: string[], current: number) => {
      try {
        const inspection = await desktopApi.inspectSourceIntake(request.profile.id, paths);
        if (intent.current === current) setResult(inspection);
      } catch (value) {
        if (intent.current === current) setError(errorText(value));
      } finally {
        if (intent.current === current) setBusy("");
      }
    },
    [request.profile.id],
  );

  const inspect = useCallback(
    async (paths: string[]) => {
      const current = ++intent.current;
      selectedPathsRef.current = paths;
      setSelectedPaths(paths);
      setBusy(copy.checking);
      setError(undefined);
      setNotice(undefined);
      setPlan(undefined);
      setResult(undefined);
      await loadInspection(paths, current);
    },
    [copy.checking, loadInspection],
  );

  useEffect(() => {
    if (request.paths.length > 0) {
      const current = ++intent.current;
      void desktopApi
        .inspectSourceIntake(request.profile.id, request.paths)
        .then((inspection) => {
          if (intent.current === current) setResult(inspection);
        })
        .catch((value) => {
          if (intent.current === current) setError(errorText(value));
        })
        .finally(() => {
          if (intent.current === current) setBusy("");
        });
    }
    return () => {
      intent.current += 1;
    };
  }, [request.paths, request.profile.id]);

  const choose = async () => {
    setError(undefined);
    try {
      const path = await pickSourcePath(request.profile, selectedPaths[0] ?? "", request.purpose);
      if (path) await inspect([path]);
      else setNotice("File selection cancelled. Nothing was changed.");
    } catch (value) {
      if (isCancellation(value)) setNotice("File selection cancelled. Nothing was changed.");
      else setError(errorText(value));
    }
  };
  const review = async (mode: SourceImportMode) => {
    if (!result?.report?.inspection?.record || selectedPaths.length !== 1) return;
    const current = ++intent.current;
    setBusy("Checking the source and destination…");
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await desktopApi.planSourceImport(request.profile.id, selectedPaths[0], mode);
      if (intent.current === current) setPlan(next);
    } catch (value) {
      if (intent.current === current) setError(errorText(value));
    } finally {
      if (intent.current === current) setBusy("");
    }
  };
  const apply = async () => {
    if (!plan) return;
    const presentation = sourceImportModePresentation(plan.mode);
    if (!presentation.known) {
      setError(presentation.explanation);
      return;
    }
    const current = ++intent.current;
    setBusy(`${presentation.label}…`);
    setError(undefined);
    try {
      const imported = await desktopApi.importSource(
        plan.profile_id,
        plan.source.path,
        plan.mode,
        plan.plan_sha256,
      );
      if (intent.current !== current) return;
      setPlan(undefined);
      if (!imported)
        setNotice("Move cancelled. The original and registration were left unchanged.");
      else {
        setNotice(sourceImportNotice(imported));
        await onAdded?.();
      }
    } catch (value) {
      if (intent.current === current) setError(errorText(value));
    } finally {
      if (intent.current === current) setBusy("");
    }
  };
  const candidate = result?.report?.inspection?.record;
  const requiredTool = result?.problem?.tool_id
    ? hostTools.find((tool) => tool.id === result.problem?.tool_id)
    : undefined;
  const inlineToolActions =
    requiredTool && hostToolActions
      ? ({
          locate: async (tool: HostToolStatus) => {
            const outcome = await hostToolActions.locate(tool);
            await inspect(selectedPathsRef.current);
            return outcome;
          },
          clear: async (toolId: string) => {
            await hostToolActions.clear(toolId);
            await inspect(selectedPathsRef.current);
          },
          recheck: async (toolId: string) => {
            const outcome = await hostToolActions.recheck(toolId);
            await inspect(selectedPathsRef.current);
            return outcome;
          },
          openOfficial: hostToolActions.openOfficial,
        } satisfies HostToolActions)
      : undefined;

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="source-intake max-h-[calc(100dvh-var(--space-8))] w-[min(760px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="source-intake-description"
      >
        <p className="eyebrow">{copy.eyebrow}</p>
        <DialogTitle id="source-intake-title" className="mb-2 text-xl">
          {copy.title(request.portName)}
        </DialogTitle>
        <DialogDescription id="source-intake-description" className="mb-4 leading-relaxed">
          {copy.description}
        </DialogDescription>
        <NavigationHints />
        <div className="source-intake-picker">
          <Button
            data-focusable
            data-autofocus
            variant="primary"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => {
              void choose();
            }}
          >
            <Icon glyph={FileSearch} />
            {copy.choose}
          </Button>
          <small>{request.profile.label}</small>
        </div>
        {busy && <p role="status">{busy}</p>}
        {result && (
          <section className="source-intake-result" aria-label={copy.resultLabel}>
            {!result.report && (
              <>
                <p className="source-intake-summary" role="status">
                  {result.summary}
                </p>
                <p>{result.next_action}</p>
                {result.problem && (
                  <details>
                    <summary data-focusable>Check details</summary>
                    <p>{result.problem.message}</p>
                  </details>
                )}
              </>
            )}
            {result.report && (
              <SourceIdentityPanel report={result.report} openEvidence={openEvidence} />
            )}
            {requiredTool && (
              <section className="source-intake-tool" aria-label="Preparation tool needed">
                <h3>Preparation tool needed</h3>
                <p>
                  This source format needs {requiredTool.display_name} before Portcove can finish
                  checking it. {copy.unchanged}
                </p>
                <HostToolRow
                  tool={requiredTool}
                  busy={Boolean(busy)}
                  actions={inlineToolActions}
                  showTechnicalId={false}
                />
              </section>
            )}
            {candidate && !plan && (
              <div className="source-intake-actions" aria-label={copy.addLabel}>
                <p>
                  {result.state_code === "recognized_exact"
                    ? copy.addExplanation
                    : result.next_action}
                </p>
                <div className="actions">
                  <Button
                    data-focusable
                    variant="primary"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void review("copy");
                    }}
                  >
                    Copy into Portcove
                  </Button>
                  <Button
                    data-focusable
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void review("use_current_location");
                    }}
                  >
                    Use current location
                  </Button>
                  <Button
                    data-focusable
                    variant="destructive"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void review("move");
                    }}
                  >
                    Review move
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
        <SourceImportReview
          plan={plan}
          busy={Boolean(busy)}
          onCancel={() => setPlan(undefined)}
          onApply={apply}
        />
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={dismiss}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
