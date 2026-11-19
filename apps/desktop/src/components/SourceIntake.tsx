import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import { desktopApi } from "../api";
import { focusAndReveal, navigationScope } from "../focus";
import { pickSourcePath, type SourcePickerPurpose } from "../file-picker";
import type {
  HostToolStatus,
  SourceImportMode,
  SourceImportPlan,
  SourceIntakeInspection,
  SourceProfile,
  SourceRecord,
  ReleaseChannel,
  StoreGameInstalls,
} from "../types";
import { errorText, isCancellation } from "../view-model";
import { SourceIdentityPanel } from "./SourceIdentity";
import {
  SourceImportReview,
  sourceImportModePresentation,
  sourceImportNotice,
  sourceImportRefreshNotice,
} from "./SourceDiscovery";
import { HostToolRow, type HostToolActions } from "./Chrome";
import { storeLabel } from "./StoreInstallChoices";
import { Icon, NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export interface SourceIntakeRequest {
  generation: number;
  portId: string;
  portName: string;
  profile: SourceProfile;
  purpose: SourcePickerPurpose;
  paths: string[];
  setup?: {
    channel: ReleaseChannel;
    other: SourceRecord | undefined;
    storeOriginals?: StoreGameInstalls["installs"] | undefined;
    savedOriginals?: { paths: string[]; limited: boolean } | undefined;
  };
}

interface SourceIntakeDialogProps {
  request: SourceIntakeRequest;
  close: () => void;
  onAdded?: () => Promise<unknown>;
  onContinueSetup?: ((registered: SourceRecord) => string | undefined) | undefined;
  returnFocus?: () => HTMLElement | null;
  openEvidence?: (evidenceId: string) => void;
  hostTools?: HostToolStatus[] | undefined;
  hostToolActions?: HostToolActions;
}

function sourceIntakeCopy(purpose: SourcePickerPurpose) {
  if (purpose === "bios")
    return {
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
      key={JSON.stringify([
        request.generation,
        request.portId,
        request.profile.id,
        request.purpose,
        request.paths,
        request.setup,
      ])}
      {...props}
    />
  );
}

function useSourceIntakeSession({
  request,
  close,
  onAdded,
  onContinueSetup,
  returnFocus,
  openEvidence,
  hostTools = [],
  hostToolActions,
}: SourceIntakeDialogProps) {
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  const copy = sourceIntakeCopy(request.purpose);
  const [result, setResult] = useState<SourceIntakeInspection>();
  const [plan, setPlan] = useState<SourceImportPlan>();
  const [busy, setBusy] = useState(request.paths.length > 0 ? copy.checking : "");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saved, setSaved] = useState<SourceRecord>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState(request.paths);
  const [storeOriginals, setStoreOriginals] = useState<StoreGameInstalls["installs"] | undefined>(
    request.setup?.storeOriginals,
  );
  const selectedPathsRef = useRef(request.paths);
  const intent = useRef(0);
  const dismiss = () => {
    if (busy) return;
    close();
    // Base UI owns restoration. After its cleanup, reveal only the control it
    // actually focused: native zoom can reposition the background while open.
    requestAnimationFrame(() => {
      const target = saved && returnFocus ? returnFocus() : opener.current;
      if (
        target instanceof HTMLElement &&
        target !== document.body &&
        target.isConnected &&
        !target.closest("[hidden], [inert]") &&
        document.activeElement === target &&
        navigationScope() === document
      )
        focusAndReveal(target);
    });
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
      setSaved(undefined);
      setRefreshFailed(false);
      await loadInspection(paths, current);
    },
    [copy.checking, loadInspection],
  );

  const savedLocations = request.setup?.savedOriginals?.paths;
  const savedLocationFailed = Boolean(
    !saved &&
    selectedPaths.length === 1 &&
    savedLocations?.includes(selectedPaths[0]!) &&
    (error || (result && !result.report?.inspection?.record)),
  );

  useEffect(() => {
    if (
      !request.setup ||
      storeOriginals !== undefined ||
      (savedLocations && !savedLocationFailed) ||
      request.purpose !== "game" ||
      (request.profile.kind !== "file-set" && request.profile.kind !== "relative-file-set") ||
      request.paths.length !== 0
    )
      return;
    let current = true;
    void desktopApi.storeGameInstalls(request.generation, request.profile.id).then(
      (report) => {
        if (current)
          setStoreOriginals(
            report.installs.filter(
              (install) => install.original_folder?.profile_id === request.profile.id,
            ),
          );
      },
      () => {
        if (current) setStoreOriginals([]);
      },
    );
    return () => {
      current = false;
    };
  }, [request, savedLocationFailed, savedLocations, storeOriginals]);

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
    const [selectedPath] = selectedPaths;
    if (
      !result?.report?.inspection?.record ||
      selectedPaths.length !== 1 ||
      selectedPath === undefined
    )
      return;
    const current = ++intent.current;
    setBusy(`Checking ${request.purpose === "bios" ? "BIOS file" : "game files"} and destination…`);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await desktopApi.planSourceImport(request.profile.id, selectedPath, mode);
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
        request.generation,
      );
      if (intent.current !== current) return;
      setPlan(undefined);
      if (!imported)
        setNotice("Move cancelled. The original files and saved location were left unchanged.");
      else {
        setSaved(imported.registered);
        setNotice(sourceImportNotice(imported));
        try {
          await onAdded?.();
        } catch {
          if (intent.current === current) {
            setRefreshFailed(true);
            setNotice(sourceImportRefreshNotice(imported));
          }
        }
      }
    } catch (value) {
      if (intent.current === current) setError(errorText(value));
    } finally {
      if (intent.current === current) setBusy("");
    }
  };
  const retryRefresh = async () => {
    const current = ++intent.current;
    setBusy("Refreshing saved file location…");
    setError(undefined);
    try {
      await onAdded?.();
      if (intent.current === current) {
        setRefreshFailed(false);
        setNotice(
          onContinueSetup
            ? "Saved file location refreshed. Continue setup when you’re ready."
            : "Saved file location refreshed. Return to the game to continue setup or play.",
        );
      }
    } catch {
      if (intent.current === current)
        setError("The saved files could not be refreshed. Retry refresh; do not add them again.");
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

  return {
    request,
    returnFocus,
    openEvidence,
    copy,
    result,
    plan,
    setPlan,
    busy,
    error,
    notice,
    saved,
    refreshFailed,
    dismiss,
    continueSetup:
      saved && !refreshFailed && onContinueSetup
        ? () => setError(onContinueSetup(saved))
        : undefined,
    choose,
    inspect,
    storeOriginals: storeOriginals ?? [],
    review,
    apply,
    retryRefresh,
    candidate,
    requiredTool,
    inlineToolActions,
  };
}

function SourceIntakeSession(props: Parameters<typeof useSourceIntakeSession>[0]) {
  const heading = useRef<HTMLHeadingElement>(null);
  const planHeading = useRef<HTMLHeadingElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const reviewChoice = useRef<SourceImportMode>(undefined);
  const {
    request,
    returnFocus,
    openEvidence,
    copy,
    result,
    plan,
    setPlan,
    busy,
    error,
    notice,
    saved,
    refreshFailed,
    dismiss,
    continueSetup,
    choose,
    inspect,
    storeOriginals,
    review,
    apply,
    retryRefresh,
    candidate,
    requiredTool,
    inlineToolActions,
  } = useSourceIntakeSession(props);
  useLayoutEffect(() => {
    if (plan && document.activeElement === document.body) {
      planHeading.current?.focus();
    } else if (!plan && reviewChoice.current && actions.current && !busy) {
      const target = actions.current.querySelector<HTMLButtonElement>(
        `[data-import-mode="${reviewChoice.current}"]`,
      );
      if (document.activeElement === document.body && target) focusAndReveal(target);
      reviewChoice.current = undefined;
    }
  }, [busy, plan]);
  const chooseMode = (mode: SourceImportMode) => {
    reviewChoice.current = mode;
    void review(mode);
  };
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={heading}
        finalFocus={saved && returnFocus ? () => returnFocus() ?? false : undefined}
        showCloseButton={false}
        reviewSize="wide"
        aria-describedby="source-intake-description"
      >
        <DialogTitle ref={heading} tabIndex={-1} id="source-intake-title" className="mb-2 text-xl">
          {copy.title(request.portName)}
        </DialogTitle>
        <DialogDescription id="source-intake-description" className="mb-4 leading-relaxed">
          {copy.description}
        </DialogDescription>
        <NavigationHints />
        {!saved && (
          <div className="grid min-w-0 justify-items-start gap-2">
            <p className="m-0 text-sm text-pc-muted-foreground">{request.profile.label}</p>
            <Button
              data-focusable
              variant={candidate ? "outline" : "primary"}
              type="button"
              disabled={Boolean(busy)}
              onClick={() => {
                void choose();
              }}
            >
              <Icon glyph={FileSearch} />
              {copy.choose}
            </Button>
          </div>
        )}
        {!saved && request.setup?.savedOriginals && (
          <section aria-label="Originals found in saved folders" className="mt-3 grid gap-2">
            {request.setup.savedOriginals.paths.map((path) => (
              <div key={path} className="grid gap-1">
                <code dir="ltr" className="saved-file-path">
                  {path}
                </code>
                <Button
                  data-focusable
                  variant="outline"
                  disabled={Boolean(busy)}
                  className="justify-self-start"
                  onClick={() => void inspect([path])}
                >
                  Check saved location
                </Button>
              </div>
            ))}
            {request.setup.savedOriginals.limited && (
              <small>More matches are available under Saved folders.</small>
            )}
          </section>
        )}
        {!saved && storeOriginals.length > 0 && (
          <section aria-label="Original files from installed games" className="mt-3 grid gap-2">
            {storeOriginals.map((install) => {
              const folder = install.original_folder;
              if (!folder) return null;
              return (
                <div key={folder.path} className="grid gap-1">
                  <Button
                    data-focusable
                    variant="outline"
                    disabled={Boolean(busy)}
                    className="justify-self-start"
                    onClick={() => void inspect([folder.path])}
                  >
                    Check {install.title} files from {storeLabel(install.store)}
                  </Button>
                  {storeOriginals.length > 1 && (
                    <code dir="ltr" className="saved-file-path">
                      {folder.path}
                    </code>
                  )}
                </div>
              );
            })}
          </section>
        )}
        {busy && (
          <p className="mt-3" role="status">
            {busy}
          </p>
        )}
        {result && (
          <section className="mt-3 grid gap-3" aria-label={copy.resultLabel}>
            {!result.report && (
              <>
                <p className="mb-0 font-bold" role="status">
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
              <SourceIdentityPanel
                report={result.report}
                evidenceLabel="Measurements and test results"
                openEvidence={openEvidence}
              />
            )}
            {requiredTool && (
              <section
                className="source-intake-tool grid gap-3"
                aria-label="Preparation tool needed"
              >
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
            {candidate && !plan && !saved && (
              <div className="grid gap-3 border-t border-pc-border pt-4" aria-label={copy.addLabel}>
                <p className="m-0">
                  {result.state_code === "recognized_exact"
                    ? copy.addExplanation
                    : result.next_action}
                </p>
                <div ref={actions} className="actions flex flex-wrap gap-2">
                  <Button
                    data-focusable
                    data-import-mode="use_current_location"
                    variant="primary"
                    disabled={Boolean(busy)}
                    onClick={() => chooseMode("use_current_location")}
                  >
                    Use current location
                  </Button>
                  <Button
                    data-focusable
                    data-import-mode="copy"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => chooseMode("copy")}
                  >
                    Copy into Portcove
                  </Button>
                  <Button
                    data-focusable
                    data-import-mode="move"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => chooseMode("move")}
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
          headingRef={planHeading}
          profiles={[request.profile]}
          busy={Boolean(busy)}
          onCancel={() => setPlan(undefined)}
          onApply={apply}
        />
        {notice && (
          <p className="mt-3" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-3 text-pc-danger-strong" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={dismiss}>
            {saved && !refreshFailed && !continueSetup ? "Return to game" : "Close"}
          </Button>
          {refreshFailed && (
            <Button data-focusable disabled={Boolean(busy)} onClick={() => void retryRefresh()}>
              Retry refresh
            </Button>
          )}
          {continueSetup && (
            <Button
              variant="primary"
              data-focusable
              disabled={Boolean(busy)}
              onClick={continueSetup}
            >
              Continue setup
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
