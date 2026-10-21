import {
  addRequiredSource,
  replaceRegisteredSource,
} from "./features/source-health/source-actions";
import desktopPackage from "../package.json";
import { AddGames } from "./components/AddGames";
import { scrollWorkspaceTo, workspaceScrollTop } from "./workspace-scroll";
import { InterfaceSizeProvider } from "./InterfaceSize";
import { ApplicationUpdateNotices } from "./features/application-update/ApplicationUpdateNotices";
import { ApplicationUpdateSettings } from "./features/application-update/ApplicationUpdates";
import { Notice } from "./components/ui/patterns";
import { useFavorites } from "./features/favorites/use-favorites";
import {
  useApplicationUpdateChoice,
  useApplicationUpdateNotice,
  useApplicationUpdateProductionTransition,
} from "./features/application-update/use-application-update";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePortcoveData } from "./features/workspace/use-workspace-data";
import { useGithubAuth } from "./features/github-auth/use-github-auth";
import { useSourceHealth } from "./features/source-health/use-source-health";
import { useSourceIntakeState } from "./features/source-intake/use-source-intake-state";
import { usePortBackups } from "./features/backups/use-port-backups";
import { useUpdateCenter } from "./features/port-updates/use-update-center";
import { useOperationState } from "./features/operations/use-operation-state";
import { targetInvocationContext } from "./features/operations/invocation-state";
import {
  useAdoptionPlanning,
  useInstallPlanning,
} from "./features/installation/use-installation-planning";
import { detailActions } from "./features/game-details/detail-actions";
import {
  libraryBrowsingKey,
  useLibraryBrowsingContext,
  type LibraryBrowsingContext,
} from "./features/app-shell/use-library-browsing-context";
import { useDetailWorkspaceNavigation } from "./features/app-shell/use-detail-workspace-navigation";
import { focusDiscTool } from "./features/app-shell/focus-disc-tool";
import {
  focusSettingsTarget,
  settingsCategoryForTarget,
} from "./features/app-shell/focus-settings-target";
import { GameFileScanProvider } from "./features/game-file-discovery/use-game-file-scan";
import {
  SetupReviewSelectionProvider,
  useSetupReviewSelection,
} from "./features/game-file-discovery/setup-review-selection";
import { useSetupSource } from "./features/app-shell/use-setup-source";
import { focusApplicationUpdateRoute } from "./features/application-update/focus-application-update-route";
import {
  useLibrarySelectionLanding,
  useLibrarySelectionReturn,
} from "./features/app-shell/use-library-selection-return";
import { useBootstrapState, type StartupFailure } from "./features/bootstrap/use-bootstrap-state";
import { AdoptionModal } from "./components/AdoptionModal";
import {
  LibraryMoveRecovery,
  transferRecoveryCanKeepOriginal,
  transferRecoveryRoot,
} from "./components/LibraryMove";
import { LibraryImportRecovery } from "./components/LibraryImport";
import {
  PageHeader,
  SettingsView,
  Sidebar,
  StatusLayer,
  type HostToolActions,
} from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { DetailPanel } from "./components/DetailPanel";
import { PortBrowser } from "./components/PortBrowser";
import { evaluateCatalogQuery, type CatalogQueryContext } from "./features/browsing/catalog-query";
import {
  useGameFileFilterContext,
  type GameFileFilterState,
} from "./features/browsing/use-game-file-filter-context";
import { ArtworkProvider } from "./artwork";
import { SourceIntakeDialog } from "./components/SourceIntake";
import { UpdateCenter } from "./components/UpdateCenter";
import { FailureDetails } from "./components/FailureDetails";
import { Button } from "./components/ui/button";
import { WorkspaceRefreshNotice } from "./features/workspace/WorkspaceRefreshNotice";
import {
  pickHostToolExecutable,
  pickInstallFolder,
  pickLibraryFolder,
  pickMetadataExportPath,
  pickSourceArchivePath,
  pickSourcePath,
  type SourcePickerPurpose,
} from "./file-picker";
import { desktopApi } from "./api";
import { useThemePreference } from "./theme";
import { useGamepadNavigation } from "./gamepad";
import { focusRegion } from "./focus";
import { overlayBackAction } from "./overlay-stack";
import { useNativeSourceDrop } from "./native-source-drop";
import { useCommandSurface } from "./use-command-surface";
import type {
  ActivityRecord,
  BootstrapStatus,
  HostToolStatus,
  PortDefinition,
  SourceRecord,
} from "./types";
import {
  currentUpdateSnapshot,
  errorText,
  filterPorts,
  indexStatuses,
  mostRecentPort,
  preparationRecoveryPort,
  requiredSourceNeeds,
  summarizeLibrary,
  type DetailDestination,
} from "./view-model";
import { gameIdentityLabel } from "./port-identity";
import { OperationPresentationProvider } from "./features/operations/operation-presentation";
import { useCollectionLayout } from "./features/browsing/use-collection-layout";
import { InvocationOwnerProvider } from "./features/operations/invocation-owner";

export const missingBootstrapError = {
  code: "state",
  message: "Portcove could not start, and no error details were provided.",
  details: {},
} as const;

export default function App() {
  return (
    <InterfaceSizeProvider>
      <InvocationOwnerProvider>
        <PortcoveApp />
      </InvocationOwnerProvider>
    </InterfaceSizeProvider>
  );
}

function PortcoveApp() {
  const [browsingContexts, setBrowsingContexts] = useState(
    () => new Map<string, LibraryBrowsingContext>(),
  );
  const rememberBrowsingContext = useCallback((root: string, context: LibraryBrowsingContext) => {
    setBrowsingContexts((current) => {
      const next = new Map(current);
      const key = libraryBrowsingKey(root);
      next.delete(key);
      next.set(key, context);
      if (next.size > 8) next.delete(next.keys().next().value!);
      return next;
    });
  }, []);
  const { bootstrap, bootstrapError, recoveryPending, switchLibrary, chooseLibrary, resetLibrary } =
    useBootstrapState();
  const {
    switchFromSettings,
    resetFromSettings,
    returnToSelection,
    consume: consumeLibrarySelectionReturn,
  } = useLibrarySelectionReturn(bootstrap?.generation, switchLibrary, resetLibrary);
  if (bootstrapError)
    return (
      <BootstrapRecovery
        error={bootstrapError}
        recoveryPending={recoveryPending}
        chooseLibrary={chooseLibrary}
        resetLibrary={resetLibrary}
      />
    );
  if (!bootstrap) return <BootstrapLoading />;
  if (!bootstrap.ready)
    return (
      <BootstrapRecovery
        error={bootstrap.error ?? missingBootstrapError}
        recoveryPending={recoveryPending}
        chooseLibrary={chooseLibrary}
        resetLibrary={resetLibrary}
      />
    );
  return (
    <GameFileScanProvider key={bootstrap.generation} generation={bootstrap.generation}>
      <SetupReviewSelectionProvider>
        <Workspace
          bootstrap={bootstrap}
          initialBrowsingContext={
            bootstrap.library_root
              ? browsingContexts.get(libraryBrowsingKey(bootstrap.library_root))
              : undefined
          }
          rememberBrowsingContext={rememberBrowsingContext}
          switchLibrary={switchFromSettings}
          resetLibrary={resetFromSettings}
          returnToSelection={returnToSelection}
          consumeLibrarySelectionReturn={consumeLibrarySelectionReturn}
        />
      </SetupReviewSelectionProvider>
    </GameFileScanProvider>
  );
}

function BootstrapLoading() {
  return (
    <main
      className="bootstrap-state m-[0_auto] flex min-h-[100vh] w-[min(42rem,_calc(100%_-_2_*_var(--space-8)))] flex-col justify-center gap-4"
      aria-live="polite"
    >
      <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)] [&:not(.eyebrow)]:text-[var(--color-text-muted)]">
        Portcove
      </p>
      <h1>Opening your Portcove library</h1>
      <p className="[&:not(.eyebrow)]:text-[var(--color-text-muted)]">
        Loading the catalog, recovery history, and release information.
      </p>
    </main>
  );
}

export function BootstrapRecovery({
  error,
  recoveryPending = false,
  chooseLibrary,
  resetLibrary,
}: {
  error: StartupFailure;
  recoveryPending?: boolean;
  chooseLibrary?: () => Promise<void>;
  resetLibrary?: () => Promise<void>;
}) {
  const [actionError, setActionError] = useState<string>();
  const [transferPending, setTransferPending] = useState(false);
  useGamepadNavigation(() => {});
  const recoveryRoot = transferRecoveryRoot(error);
  const canKeepOriginal = transferRecoveryCanKeepOriginal(error);
  const importRoot = transferRecoveryRoot(error, "import_destination");
  const pending = recoveryPending || transferPending;
  return (
    <main className="bootstrap-state bootstrap-error m-[0_auto] flex min-h-[100vh] w-[min(42rem,_calc(100%_-_2_*_var(--space-8)))] flex-col justify-center gap-4">
      <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)] [&:not(.eyebrow)]:text-[var(--color-text-muted)]">
        Portcove could not start
      </p>
      <h1>Portcove couldn’t start</h1>
      <p className="[&:not(.eyebrow)]:text-[var(--color-text-muted)]" role="alert">
        {errorText(error)}
      </p>
      {error.presentation ? (
        <FailureDetails
          presentation={error.presentation}
          code={error.code}
          contextLabel={startupDetailLabel}
        />
      ) : (
        <StartupTechnicalDetails error={error} />
      )}
      {recoveryRoot && (
        <LibraryMoveRecovery
          source={recoveryRoot}
          canKeepOriginal={canKeepOriginal}
          disabled={pending}
          onBusyChange={setTransferPending}
        />
      )}
      {importRoot && (
        <LibraryImportRecovery
          destination={importRoot}
          disabled={pending}
          onBusyChange={setTransferPending}
        />
      )}
      <p className="[&:not(.eyebrow)]:text-[var(--color-text-muted)]">
        {recoveryRoot || importRoot
          ? "Review the recovery above first. Retry startup after resolving the unfinished transfer, or choose a different library."
          : "Review the error details, then retry startup. If the current library is the cause, choose another library or return to the platform default."}
      </p>
      <div className="button-row" aria-busy={pending}>
        <Button
          className="[align-self:flex-start]"
          type="button"
          variant={recoveryRoot || importRoot ? "outline" : "primary"}
          disabled={pending}
          onClick={() => window.location.reload()}
        >
          Retry startup
        </Button>
        <Button
          className="[align-self:flex-start]"
          type="button"
          variant="outline"
          disabled={pending || !chooseLibrary}
          onClick={() => {
            void chooseLibrary?.().catch((value) => setActionError(errorText(value)));
          }}
        >
          Choose library
        </Button>
        <Button
          className="[align-self:flex-start]"
          type="button"
          variant="outline"
          disabled={pending || !resetLibrary}
          onClick={() => {
            void resetLibrary?.().catch((value) => setActionError(errorText(value)));
          }}
        >
          Use platform default
        </Button>
      </div>
      {actionError && (
        <p className="[&:not(.eyebrow)]:text-[var(--color-text-muted)]" role="alert">
          {actionError}
        </p>
      )}
    </main>
  );
}

function StartupTechnicalDetails({ error }: { error: StartupFailure }) {
  return (
    <details>
      <summary data-focusable>Technical details</summary>
      <dl className="grid gap-3 rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-4">
        <div>
          <dt className="text-xs text-pc-muted-foreground">Error code</dt>
          <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
            {error.code}
          </dd>
        </div>
        {Object.entries(error.details).map(([key, value]) => {
          const label = startupDetailLabel(key);
          return (
            <div key={key}>
              <dt className="text-xs text-pc-muted-foreground">{label ?? <code>{key}</code>}</dt>
              <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}

function startupDetailLabel(key: string) {
  const labels: Record<string, string> = {
    path: "Path",
    library_root: "Library folder",
    lock_path: "Library lock file",
    cause: "Cause",
    expected_version: "Expected version",
    actual_version: "Actual version",
    library_schema_version: "Library format version",
    supported_schema_version: "Supported library format version",
    migration_version: "Migration version",
    migration_name: "Migration",
    recovery_action: "Recovery action",
    transfer_id: "Transfer ID",
    import_destination: "Import destination",
    retained_source: "Original library folder",
  };
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

function Workspace({
  bootstrap,
  initialBrowsingContext,
  rememberBrowsingContext,
  switchLibrary,
  resetLibrary,
  returnToSelection,
  consumeLibrarySelectionReturn,
}: {
  bootstrap: BootstrapStatus;
  initialBrowsingContext?: LibraryBrowsingContext | undefined;
  rememberBrowsingContext: (root: string, context: LibraryBrowsingContext) => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  returnToSelection?: "switch" | "reset" | undefined;
  consumeLibrarySelectionReturn: () => void;
}) {
  const data = usePortcoveData(bootstrap.generation);
  const collection = useCollectionLayout(bootstrap.library_root);
  const favorites = useFavorites(bootstrap.generation);
  const [setupSource, setSetupSource] = useSetupSource(data.sources);
  const operations = useOperationState({
    libraryGeneration: bootstrap.generation,
    libraryLabel: bootstrap.library_root ?? "Current library",
    refresh: data.retryRefresh,
    refreshActivities: data.refreshActivities,
    invalidateDiagnostics: data.invalidateDiagnostics,
    activities: data.activities,
  });
  const github = useGithubAuth(operations.perform, operations.setError, bootstrap.generation);
  const updates = useUpdateCenter(operations.perform, data.statuses);
  const {
    ui,
    switchView,
    workspace,
    switchLibraryWithContext,
    resetLibraryWithContext,
    preferenceFailure,
    saveBrowsingPreferences,
  } = useLibraryBrowsingContext({
    root: bootstrap.library_root,
    initial: initialBrowsingContext,
    returnToSelection,
    remember: rememberBrowsingContext,
    switchLibrary,
    resetLibrary,
    ready: Boolean(data.catalog),
    installedCount: data.catalog
      ? data.statuses.filter((status) => status.active || status.external_runtime).length
      : undefined,
    catalogCount: data.catalog?.ports.length,
  });
  const { catalog, diagnosticRevision, diagnosticsStale, doctor, refreshDiagnostics } = data;
  useEffect(() => {
    if (
      catalog &&
      (ui.view === "settings" || ui.view === "updates") &&
      (diagnosticsStale || !doctor)
    )
      void refreshDiagnostics();
  }, [catalog, diagnosticRevision, diagnosticsStale, doctor, refreshDiagnostics, ui.view]);
  const { applicationUpdate, applicationUpdateChoice, applicationUpdateProductionTransition } =
    useWorkspaceApplicationUpdates(operations.setError);
  const {
    request: sourceIntake,
    open: openSourceIntake,
    close: closeSourceIntake,
  } = useSourceIntakeState(data.catalog);
  const nativeSourceDrag = useNativeSourceDrop((drop) =>
    openSourceIntake(drop.portId, drop.profileId, drop.paths),
  );
  const selectedPort = data.catalog?.ports.find((port) => port.id === ui.selectedId);
  const inspectionProfiles = useMemo(
    () =>
      ui.view === "settings"
        ? data.sources.map((source) => source.profile_id)
        : [selectedPort?.source_profile, selectedPort?.bios_source_profile].filter(
            (profile): profile is string => Boolean(profile),
          ),
    [data.sources, selectedPort?.bios_source_profile, selectedPort?.source_profile, ui.view],
  );
  const sourceHealth = useSourceHealth(
    operations.perform,
    data.sources,
    inspectionProfiles,
    JSON.stringify(data.catalog?.source_catalog ?? null),
  );
  const appearance = useThemePreference();
  const gameFileQuery = useGameFileFilterContext({
    catalog: data.catalog,
    sources: data.sources,
    statuses: data.statuses,
    browsing: data.browsing,
    generation: bootstrap.generation,
    libraryKey: bootstrap.library_root,
  });
  const model = useAppModel(data, ui, bootstrap.library_root, gameFileQuery);
  const installPlanning = useInstallPlanning(
    model.port?.id,
    model.status?.channel ?? model.port?.channels[0],
    operations.perform,
    model.port
      ? targetInvocationContext(
          "Review installation",
          { kind: "port", id: model.port.id, label: gameIdentityLabel(model.port) },
          bootstrap.generation,
          "library",
        )
      : undefined,
  );
  const setupReviews = useSetupReviewSelection();
  const { pendingReview, takeReview } = setupReviews;
  const { review: reviewInstallation } = installPlanning;
  useEffect(() => {
    const request = pendingReview;
    if (!request) return;
    // Consume once, including StrictMode replay, and never plan a different detail.
    const matches =
      ui.selectedId === request.portId &&
      model.port?.id === request.portId &&
      model.status?.channel === request.channel &&
      !data.refreshFailure &&
      !model.status.active &&
      !model.status.external_runtime &&
      model.status.port_actions?.some(
        (action) => action.action === "install" && action.availability === "allowed",
      );
    if (takeReview(request) && matches) void reviewInstallation();
  }, [
    pendingReview,
    takeReview,
    ui.selectedId,
    model.port?.id,
    model.status,
    data.refreshFailure,
    reviewInstallation,
  ]);
  const backups = usePortBackups(model.port?.id);
  useLibrarySelectionLanding(returnToSelection, workspace, consumeLibrarySelectionReturn);
  const { adoptOpen, selectedId, setAdoptOpen, setSelectedId, setView } = ui;
  const availablePortIds = useMemo(
    () => (data.catalog ? new Set(data.catalog.ports.map((port) => port.id)) : undefined),
    [data.catalog],
  );
  const {
    close: closePortDetails,
    invalidate: invalidatePortDetails,
    open: openPortDetails,
  } = useDetailWorkspaceNavigation(workspace, setSelectedId, availablePortIds);
  const [pendingToolId, setPendingToolId] = useState<string>();
  const [addGamesOpen, setAddGamesOpen] = useState(false);
  const [addGamesStarted, setAddGamesStarted] = useState(false);
  const addGamesReturn = useRef(0);
  const { setActivitySection } = ui;
  const setPrimaryView = useCallback(
    (...args: Parameters<typeof setView>) => {
      const nextView = typeof args[0] === "function" ? args[0](ui.view) : args[0];
      if (nextView === "updates") setActivitySection("tasks");
      if (nextView !== "settings") setPendingToolId(undefined);
      const detailReturn = invalidatePortDetails();
      switchView(
        nextView,
        () => {
          if (detailReturn) setSelectedId(undefined);
          setView(nextView);
        },
        detailReturn && {
          scrollTop: detailReturn.scrollTop,
          focusOrigin: detailReturn.originKey,
        },
      );
    },
    [invalidatePortDetails, setSelectedId, setView, switchView, ui.view, setActivitySection],
  );
  const openHostTool = (toolId: string) => {
    setPendingToolId(toolId);
    ui.setSettingsCategory("game-files");
    setPrimaryView("settings");
    window.requestAnimationFrame(() => focusDiscTool());
  };
  const openAddGames = () => {
    addGamesReturn.current = workspaceScrollTop(workspace.current);
    setAddGamesStarted(true);
    setAddGamesOpen(true);
    setPrimaryView("library");
    requestAnimationFrame(() => {
      scrollWorkspaceTo(workspace.current, 0);
      workspace.current?.querySelector<HTMLElement>("h1")?.focus();
    });
  };
  const closeAddGames = () => {
    setAddGamesOpen(false);
    requestAnimationFrame(() => {
      scrollWorkspaceTo(workspace.current, addGamesReturn.current);
      workspace.current
        ?.querySelector<HTMLElement>("[data-add-games-trigger]")
        ?.focus({ preventScroll: true });
    });
  };
  usePendingHostToolFocus(data, ui.view, pendingToolId, setPendingToolId);
  const commandSurface = useCommandSurface({
    view: ui.view,
    recent: model.recent,
    installedCount: model.overview.installed,
    busy: Boolean(operations.busy),
    setView: setPrimaryView,
    setAdoptOpen: ui.setAdoptOpen,
    setSelectedId: (portId) => openPortDetails(portId, `command-trigger:${ui.view}`),
    checkAll: updates.checkAll,
    openUpdates: () => {
      setPrimaryView("updates");
      ui.setActivitySection("updates");
    },
  });
  const adopting = [...operations.pendingOperations.values()].some(
    (record) => record.name === "adopt",
  );
  const { open: commandOpen, setOpen: setCommandOpen } = commandSurface;
  const handleBack = useCallback(() => {
    const action = overlayBackAction({
      paletteOpen: commandOpen,
      adoptionOpen: adoptOpen,
      detailOpen: Boolean(selectedId),
    });
    if (action === "close-palette") setCommandOpen(false);
    else if (action === "close-adoption") {
      if (!adopting) setAdoptOpen(false);
    } else if (action === "close-detail") closePortDetails();
    else focusRegion("sidebar");
  }, [
    adoptOpen,
    adopting,
    closePortDetails,
    commandOpen,
    selectedId,
    setAdoptOpen,
    setCommandOpen,
  ]);
  const controller = useGamepadNavigation(handleBack);
  const hostToolActions: HostToolActions = {
    locate: async (tool: HostToolStatus) => {
      const path = await pickHostToolExecutable(tool.display_name, tool.path ?? "");
      if (!path) return undefined;
      const result = await desktopApi.setHostToolPath(tool.id, path);
      await data.refreshDiagnosticsAfterMutation();
      return result;
    },
    clear: async (toolId: string) => {
      await desktopApi.clearHostToolPath(toolId);
      await data.refreshDiagnosticsAfterMutation();
    },
    recheck: async (toolId: string) => desktopApi.recheckHostTool(toolId),
    openOfficial: (toolId: string) => desktopApi.openHostToolOfficialSite(toolId),
  };
  const reviewApplicationUpdate = (route: Parameters<typeof focusApplicationUpdateRoute>[0]) => {
    ui.setSettingsCategory("updates");
    setPrimaryView("settings");
    window.requestAnimationFrame(() => focusApplicationUpdateRoute(route));
  };
  const dismissApplicationUpdateChoice = () => {
    applicationUpdateChoice.dismiss();
    window.requestAnimationFrame(() => focusRegion("workspace"));
  };
  const completeApplicationUpdateProductionTransition = async (
    decision: "use-stable" | "keep-preview",
  ) => {
    if (await applicationUpdateProductionTransition.complete(decision)) {
      window.requestAnimationFrame(() => focusRegion("workspace"));
    }
  };
  const dismissApplicationUpdateProductionTransition = () => {
    applicationUpdateProductionTransition.dismiss();
    window.requestAnimationFrame(() => focusRegion("workspace"));
  };

  const renderPageHeader = () =>
    !model.port &&
    (addGamesOpen && ui.view === "library" ? (
      <h1 tabIndex={-1}>Add games</h1>
    ) : (
      <PageHeader
        view={ui.view}
        query={ui.query}
        setQuery={ui.setQuery}
        portCount={data.catalog?.ports.length ?? 0}
        onOpenCommands={() => commandSurface.setOpen(true)}
      />
    ));
  const renderPreferenceFailure = () =>
    preferenceFailure && (
      <Notice intent="danger" className="" role="alert">
        <div data-slot="notice-body">
          <strong>Browsing choices are not saved</strong>
          <p>
            {preferenceFailure === "read"
              ? "Saved browsing choices for this library could not be read. The saved data has been kept. Save your current choices to replace these browsing preferences."
              : "Your browsing choices work for this session, but could not be saved for a restart."}
          </p>
          <Button
            data-focusable
            variant="outline"
            onClick={() => {
              if (saveBrowsingPreferences())
                window.requestAnimationFrame(() => focusRegion("workspace"));
            }}
          >
            {preferenceFailure === "read" ? "Save current browsing choices" : "Retry saving"}
          </Button>
        </div>
      </Notice>
    );
  const renderWorkspaceView = () =>
    model.port ? (
      <SelectedPortPanel
        model={model}
        ui={ui}
        operations={operations}
        sourceHealth={sourceHealth}
        installPlanning={installPlanning}
        backups={backups}
        activities={data.activities}
        libraryGeneration={bootstrap.generation}
        refreshAfterMutation={() => {
          void data.refreshAfterMutation();
        }}
        openSourceIntake={openSourceIntake}
        openHostTool={openHostTool}
        openLibraryStorage={() => {
          ui.setSettingsCategory("library-storage");
          setPrimaryView("settings");
          window.requestAnimationFrame(() => focusSettingsTarget("library-storage"));
        }}
        close={closePortDetails}
      />
    ) : addGamesOpen && ui.view === "library" ? null : (
      <CurrentView
        onAddGames={openAddGames}
        collection={collection}
        favorites={favorites}
        data={data}
        ui={{ ...ui, setView: setPrimaryView }}
        model={model}
        operations={operations}
        github={github}
        updates={updates}
        sourceHealth={sourceHealth}
        appearance={appearance}
        bootstrap={bootstrap}
        switchLibrary={switchLibraryWithContext}
        resetLibrary={resetLibraryWithContext}
        nativeSourceDrag={nativeSourceDrag}
        hostToolActions={hostToolActions}
        applicationUpdates={
          <ApplicationUpdateSettings
            perform={operations.perform}
            currentVersion={desktopPackage.version}
            generation={bootstrap.generation}
            disabled={Boolean(operations.busy)}
            automaticNotice={applicationUpdate.notice}
            preferencesState={applicationUpdateChoice}
          />
        }
        openPortDetails={openPortDetails}
        setupSource={setupSource}
        setSetupSource={setSetupSource}
      />
    );
  const renderSourceIntake = () =>
    sourceIntake && (
      <SourceIntakeDialog
        request={sourceIntake}
        close={closeSourceIntake}
        onAdded={data.refreshAfterMutation}
        returnFocus={() => {
          const detail = [...document.querySelectorAll<HTMLElement>("[data-detail-port-id]")].find(
            (element) => element.dataset.detailPortId === sourceIntake.portId,
          );
          return (
            detail?.querySelector<HTMLButtonElement>(".primary-actions button:not(:disabled)") ??
            detail?.querySelector<HTMLButtonElement>(".detail-back") ??
            document.querySelector<HTMLButtonElement>(
              'section[aria-label="Add games workspace"]:not([hidden]) #add-games-check-files',
            ) ??
            null
          );
        }}
        openEvidence={(evidenceId) => {
          void operations.perform(
            "open source evidence",
            () => desktopApi.openSourceEvidence(evidenceId),
            { refresh: "none", invalidateDiagnostics: false },
          );
        }}
        hostTools={data.doctor?.host_tools}
        hostToolActions={hostToolActions}
      />
    );
  return (
    <OperationPresentationProvider
      generation={bootstrap.generation}
      pending={operations.pendingOperations}
    >
      <ArtworkProvider generation={bootstrap.generation} catalog={data.catalog}>
        <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)] bg-[var(--color-bg)] max-[75rem]:grid-cols-[var(--layout-sidebar-compact)_minmax(0,_1fr)]">
          <Sidebar
            view={ui.view}
            setView={setPrimaryView}
            controller={controller}
            installedCount={model.overview.installed}
            updateCount={
              data.statuses.filter(
                (status) => currentUpdateSnapshot(status)?.check.update_available,
              ).length
            }
            activities={data.activities}
            onAdopt={() => ui.setAdoptOpen(true)}
            onAbout={() => {
              ui.setSettingsCategory("about");
              setPrimaryView("settings");
              window.requestAnimationFrame(() => {
                const heading = document.getElementById("settings-about-heading");
                heading?.scrollIntoView({ block: "start" });
                heading?.focus({ preventScroll: true });
              });
            }}
          />
          <main
            className="min-h-0 w-full min-w-0 overflow-auto px-10 pt-8 pb-12 max-[75rem]:px-6 max-[75rem]:pt-7 max-[75rem]:pb-10 max-[65rem]:px-5"
            ref={workspace}
            data-focus-region="workspace"
            tabIndex={-1}
          >
            <div
              className={
                !model.port && (ui.view === "catalog" || (ui.view === "library" && !addGamesOpen))
                  ? "w-full min-w-0"
                  : "w-full max-w-(--layout-content-max) min-w-0"
              }
            >
              {renderPageHeader()}
              <StatusLayer
                invocations={operations.invocations}
                operationEvents={operations.operationEvents}
                dismissInvocation={operations.dismissInvocation}
                openActivity={(id) => {
                  ui.setReviewedActivityId(id);
                  setPrimaryView("updates");
                }}
                error={operations.error}
                clearError={() => operations.setError(undefined)}
                reviewCurrentState={data.retryRefresh}
                preparationRecovery={(record) => {
                  const id = preparationRecoveryPort(
                    record.failure,
                    data.catalog?.ports ?? [],
                    data.statuses,
                  );
                  return id ? () => openPortDetails(id, "error:preparation-review") : undefined;
                }}
                operation={operations.operation}
                busy={operations.busy}
                featureNotices={
                  <ApplicationUpdateNotices
                    updateNotice={applicationUpdate.notice}
                    updateChoiceRequired={applicationUpdateChoice.choiceRequired}
                    productionTransitionRequired={
                      applicationUpdateProductionTransition.offerRequired
                    }
                    productionTransitionBusy={applicationUpdateProductionTransition.busy}
                    reviewUpdate={reviewApplicationUpdate}
                    dismissUpdate={applicationUpdate.dismiss}
                    dismissUpdateChoice={dismissApplicationUpdateChoice}
                    useStable={() =>
                      void completeApplicationUpdateProductionTransition("use-stable")
                    }
                    keepPreview={() =>
                      void completeApplicationUpdateProductionTransition("keep-preview")
                    }
                    dismissProductionTransition={dismissApplicationUpdateProductionTransition}
                  />
                }
              />
              <WorkspaceRefreshNotice
                failure={data.refreshFailure}
                recoveryFailure={data.recoveryFailure}
                hasSnapshot={Boolean(data.catalog)}
                refreshing={data.refreshing}
                retry={data.retryRefresh}
                retryRecovery={data.retryRecovery}
                subscriptionFailure={
                  data.subscriptionFailure?.error ?? operations.subscriptionFailure
                }
              />
              {renderPreferenceFailure()}
              {renderWorkspaceView()}
              {addGamesStarted && (
                <AddGames
                  key={bootstrap.generation}
                  active={addGamesOpen && ui.view === "library" && !model.port}
                  generation={bootstrap.generation}
                  ports={data.catalog?.ports ?? []}
                  profiles={data.catalog?.source_profiles ?? []}
                  statuses={model.statusMap}
                  sources={data.sources}
                  refreshFailed={Boolean(data.refreshFailure)}
                  onAdded={data.refreshAfterMutation}
                  onOpenPort={openPortDetails}
                  onCheckFiles={openSourceIntake}
                  onBrowseCatalog={() => setPrimaryView("catalog")}
                  onCopyInstallation={() => ui.setAdoptOpen(true)}
                  setupSource={setupSource}
                  setSetupSource={setSetupSource}
                  close={closeAddGames}
                />
              )}
            </div>
          </main>
          <AdoptionOverlay
            ui={ui}
            operations={operations}
            libraryGeneration={bootstrap.generation}
            ports={data.catalog?.ports ?? []}
          />
          <CommandPalette
            open={commandSurface.open}
            commands={commandSurface.commands}
            close={() => commandSurface.setOpen(false)}
          />
          {renderSourceIntake()}
        </div>
      </ArtworkProvider>
    </OperationPresentationProvider>
  );
}

type DataState = ReturnType<typeof usePortcoveData>;
type UiState = ReturnType<typeof useLibraryBrowsingContext>["ui"];
type OperationState = ReturnType<typeof useOperationState>;
type GithubState = ReturnType<typeof useGithubAuth>;
type UpdateState = ReturnType<typeof useUpdateCenter>;
type SourceHealthState = ReturnType<typeof useSourceHealth>;
type AppearanceState = ReturnType<typeof useThemePreference>;
type InstallPlanningState = ReturnType<typeof useInstallPlanning>;
type BackupState = ReturnType<typeof usePortBackups>;

function useAppModel(
  data: DataState,
  ui: UiState,
  libraryRoot?: string | null,
  gameFileQuery?: GameFileFilterState,
) {
  const { selectedId, setBiosPath, setSourcePath } = ui;
  const { catalog, sources, statuses, browsing } = data;
  const statusMap = useMemo(() => indexStatuses(statuses), [statuses]);
  const gameFileQueryContext = useMemo(
    () => JSON.stringify([catalog, sources, statuses, browsing?.workspace_binding_sha256]),
    [catalog, sources, statuses, browsing?.workspace_binding_sha256],
  );
  // Catalog and statuses arrive together in the accepted generation-bound snapshot.
  const queryContext = useMemo<CatalogQueryContext>(
    () =>
      catalog && libraryRoot
        ? {
            library: { id: libraryRoot, statuses: statusMap },
            gameFiles: gameFileQuery?.context,
            browsing: browsing ?? undefined,
            devicePlatform: browsing?.host_platform,
          }
        : {},
    [catalog, libraryRoot, statusMap, gameFileQuery?.context, browsing],
  );
  const visible = useMemo(
    () =>
      filterPorts(
        ui.view === "library"
          ? ["all", "ready", "setup"].includes(ui.libraryReadiness)
            ? filterPorts(
                data.catalog?.ports ?? [],
                statusMap,
                "library",
                ui.libraryReadiness as "all" | "ready" | "setup",
                "",
              )
            : []
          : (data.catalog?.ports ?? []),
        statusMap,
        ui.view,
        ui.filter,
        ui.query,
        ui.catalogSort,
        queryContext,
      ),
    [
      data.catalog,
      statusMap,
      ui.view,
      ui.filter,
      ui.libraryReadiness,
      ui.query,
      ui.catalogSort,
      queryContext,
    ],
  );
  const catalogFilterCandidates = useMemo(
    () =>
      ui.view === "catalog" && data.catalog
        ? filterPorts(data.catalog.ports, statusMap, "catalog", "all", ui.query)
        : undefined,
    [data.catalog, statusMap, ui.view, ui.query],
  );
  const libraryFilterCandidates = useMemo(
    () =>
      ui.view === "library" && data.catalog
        ? filterPorts(data.catalog.ports, statusMap, "library", "all", ui.query)
        : undefined,
    [data.catalog, statusMap, ui.view, ui.query],
  );
  const overview = useMemo(
    () => summarizeLibrary(data.catalog?.ports ?? [], statusMap),
    [data.catalog, statusMap],
  );
  const recent = useMemo(
    () => mostRecentPort(data.catalog?.ports ?? [], statusMap),
    [data.catalog, statusMap],
  );
  const sourceNeeds = useMemo(
    () =>
      requiredSourceNeeds(
        data.catalog?.ports ?? [],
        data.catalog?.source_profiles ?? [],
        statusMap,
        data.sources,
      ),
    [data.catalog, data.sources, statusMap],
  );
  const selection = useMemo(
    () => selectedPort(catalog, sources, selectedId, statusMap),
    [catalog, selectedId, sources, statusMap],
  );
  const browsingMatch = useMemo(
    () =>
      selection.port && queryContext.browsing
        ? evaluateCatalogQuery(
            [selection.port],
            typeof ui.filter === "string"
              ? { version: 1, channels: ui.filter === "all" ? [] : [ui.filter] }
              : ui.filter,
            queryContext,
          )
        : undefined,
    [selection.port, ui.filter, queryContext],
  );
  useEffect(() => {
    setSourcePath(selection.source?.path ?? "");
  }, [selectedId, selection.source?.path, setSourcePath]);
  useEffect(() => {
    setBiosPath(selection.bios?.path ?? "");
  }, [selectedId, selection.bios?.path, setBiosPath]);
  return {
    statusMap,
    queryContext,
    gameFileQueryContext,
    gameFileQuery,
    visible,
    catalogFilterCandidates,
    libraryFilterCandidates,
    overview,
    recent,
    sourceNeeds,
    ...selection,
    browsingMatch,
  };
}

function selectedPort(
  catalog: DataState["catalog"],
  sources: DataState["sources"],
  selectedId: string | undefined,
  statuses: ReturnType<typeof indexStatuses>,
) {
  const port = catalog?.ports.find((candidate) => candidate.id === selectedId);
  if (!port)
    return {
      port: undefined,
      status: undefined,
      source: undefined,
      sourceProfile: undefined,
      bios: undefined,
      biosProfile: undefined,
    };
  return {
    port,
    status: statuses.get(port.id),
    source: sources.find((source) => source.profile_id === port.source_profile),
    sourceProfile: catalog?.source_profiles?.find((profile) => profile.id === port.source_profile),
    bios: sources.find((source) => source.profile_id === port.bios_source_profile),
    biosProfile: catalog?.source_profiles?.find(
      (profile) => profile.id === port.bios_source_profile,
    ),
  };
}

function CurrentView({
  onAddGames,
  collection,
  favorites,
  data,
  ui,
  model,
  operations,
  github,
  updates,
  sourceHealth,
  appearance,
  bootstrap,
  switchLibrary,
  resetLibrary,
  nativeSourceDrag,
  hostToolActions,
  applicationUpdates,
  openPortDetails,
  setupSource,
  setSetupSource,
}: {
  onAddGames: () => void;
  collection: ReturnType<typeof useCollectionLayout>;
  favorites: ReturnType<typeof useFavorites>;
  data: DataState;
  ui: UiState;
  model: ReturnType<typeof useAppModel>;
  operations: OperationState;
  github: GithubState;
  updates: UpdateState;
  sourceHealth: SourceHealthState;
  appearance: AppearanceState;
  bootstrap: BootstrapStatus;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  nativeSourceDrag: ReturnType<typeof useNativeSourceDrop>;
  hostToolActions: HostToolActions;
  applicationUpdates: ReactNode;
  openPortDetails: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  setupSource?: SourceRecord | undefined;
  setSetupSource: (source?: SourceRecord) => void;
}) {
  if (ui.view === "updates")
    return (
      <UpdateCenter
        operationEvents={operations.operationEvents}
        section={ui.activitySection}
        onSectionChange={ui.setActivitySection}
        generation={bootstrap.generation}
        ports={data.catalog?.ports ?? []}
        sourceProfiles={data.catalog?.source_profiles ?? []}
        statuses={model.statusMap}
        activities={data.activities}
        activityFeed={data.activityFeed}
        reviewedActivityId={ui.reviewedActivityId}
        onReviewActivity={ui.setReviewedActivityId}
        outcomes={updates.outcomes}
        batchRead={updates.batchRead}
        busy={operations.busy}
        repair={data.doctor?.repair}
        diagnosticsRefreshing={data.diagnosticRefreshing}
        diagnosticsStale={data.diagnosticsStale}
        diagnosticFailure={data.diagnosticFailure?.error}
        refreshDiagnostics={data.refreshDiagnostics}
        cleanupChanged={() =>
          Promise.allSettled([data.refresh(), data.refreshDiagnosticsAfterMutation()])
        }
        checkAll={updates.checkAll}
        perform={operations.perform}
        onLaunch={(portId) => {
          const port = data.catalog?.ports.find((port) => port.id === portId);
          if (port)
            void operations.perform(
              "launch",
              () => desktopApi.launch(portId, "", bootstrap.generation),
              {
                context: {
                  action: "Launch",
                  target: { kind: "port", id: portId, label: gameIdentityLabel(port) },
                  libraryGeneration: bootstrap.generation,
                  exclusionScope: "target",
                },
              },
            );
        }}
        onSelect={openPortDetails}
        onOpenSettings={(target, sourceProfileId) => {
          ui.setSettingsCategory(settingsCategoryForTarget(target));
          ui.setView("settings");
          window.requestAnimationFrame(() => focusSettingsTarget(target, sourceProfileId));
        }}
      />
    );
  if (ui.view === "settings")
    return (
      <SettingsView
        category={ui.settingsCategory}
        onCategoryChange={ui.setSettingsCategory}
        generation={bootstrap.generation}
        ports={data.catalog?.ports ?? []}
        statuses={model.statusMap}
        doctor={data.doctor}
        storage={data.storage}
        github={github}
        busy={operations.busy}
        sources={data.sources}
        workspaceRefreshFailed={Boolean(data.refreshFailure)}
        appearance={appearance}
        librarySelection={bootstrap.selection ?? undefined}
        chooseLibrary={pickLibraryFolder}
        switchLibrary={switchLibrary}
        resetLibrary={resetLibrary}
        sourceProfiles={data.catalog?.source_profiles ?? []}
        onSourceAdded={data.refreshAfterMutation}
        onOpenPort={openPortDetails}
        onReviewSaves={(portId, origin) => openPortDetails(portId, origin, "saves")}
        onOpenActivity={() => {
          ui.setView("updates");
          ui.setActivitySection("tasks");
          window.requestAnimationFrame(() =>
            document.querySelector<HTMLElement>("main h1")?.focus(),
          );
        }}
        setupSource={setupSource}
        setSetupSource={setSetupSource}
        onCatalogChanged={data.refreshAfterMutation}
        onOpenGameUpdates={() => {
          ui.setView("updates");
          ui.setActivitySection("updates");
          window.requestAnimationFrame(() => {
            const heading = document.querySelector<HTMLElement>("main h1");
            heading?.scrollIntoView({ block: "start" });
            heading?.focus({ preventScroll: true });
          });
        }}
        hostToolActions={hostToolActions}
        applicationUpdates={applicationUpdates}
        diagnosticsRefreshing={data.diagnosticRefreshing}
        diagnosticsStale={data.diagnosticsStale}
        diagnosticFailure={data.diagnosticFailure?.error}
        refreshDiagnostics={data.refreshDiagnostics}
        createSupportBundle={() =>
          operations.perform("support bundle", desktopApi.createSupportBundle, {
            refresh: "none",
            invalidateDiagnostics: false,
          })
        }
        exportMetadata={() =>
          operations.perform(
            "export library metadata",
            async () => {
              const path = await pickMetadataExportPath();
              return path ? desktopApi.exportLibraryMetadata(path) : undefined;
            },
            { refresh: "none", invalidateDiagnostics: false },
          )
        }
        sourceOutcomes={sourceHealth.outcomes}
        sourceInspections={{
          reports: sourceHealth.inspections,
          reads: sourceHealth.inspectionReads,
          retry: sourceHealth.inspectSource,
        }}
        verifySources={() => {
          void sourceHealth.verifyAll();
        }}
        openSourceEvidence={(evidenceId) => {
          void operations.perform(
            "open source evidence",
            () => desktopApi.openSourceEvidence(evidenceId),
            { refresh: "none", invalidateDiagnostics: false },
          );
        }}
        replaceSource={(source) => {
          const profile = data.catalog?.source_profiles?.find(
            (candidate) => candidate.id === source.profile_id,
          );
          void replaceRegisteredSource(
            profile,
            source,
            sourcePickerPurpose(source.profile_id, data.catalog?.ports ?? []),
            operations.perform,
            operations.setError,
            bootstrap.generation,
          );
        }}
        sourceNeeds={model.sourceNeeds}
        installedCount={model.overview.installed}
        sourceRequirementsState={
          data.catalog ? "available" : data.refreshFailure ? "unavailable" : "loading"
        }
        addSource={(profile, archive) => {
          void addRequiredSource(
            profile,
            archive,
            sourcePickerPurpose(profile.id, data.catalog?.ports ?? []),
            operations.perform,
            operations.setError,
            bootstrap.generation,
          );
        }}
      />
    );
  if (!data.catalog && data.refreshFailure) return null;
  return (
    <PortBrowser
      collectionLayout={collection.value}
      setCollectionLayout={collection.set}
      collectionLayoutFailure={collection.failure}
      favorites={favorites}
      view={ui.view}
      ports={model.visible}
      catalogFilterCandidates={model.catalogFilterCandidates}
      libraryFilterCandidates={model.libraryFilterCandidates}
      queryContext={model.queryContext}
      gameFileQuery={model.gameFileQuery}
      libraryReadiness={ui.libraryReadiness}
      setLibraryReadiness={ui.setLibraryReadiness}
      statuses={model.statusMap}
      overview={model.overview}
      recent={model.recent}
      filter={ui.filter}
      query={ui.query}
      catalogSort={ui.catalogSort}
      setCatalogSort={ui.setCatalogSort}
      setFilter={ui.setFilter}
      onSelect={openPortDetails}
      onContinue={(portId) => {
        const port = data.catalog?.ports.find((port) => port.id === portId);
        if (port)
          void operations.perform(
            "launch",
            () => desktopApi.launch(portId, "", bootstrap.generation),
            {
              context: {
                action: "Launch",
                target: { kind: "port", id: portId, label: gameIdentityLabel(port) },
                libraryGeneration: bootstrap.generation,
                exclusionScope: "target",
              },
            },
          );
      }}
      onBrowseCatalog={onAddGames}
      onConnectGameFiles={() => {
        ui.setSettingsCategory("game-files");
        ui.setView("settings");
        window.requestAnimationFrame(() => focusSettingsTarget("add-game-file-root"));
      }}
      steamBatch={{
        ports: installedSteamBatchPorts(data, model),
        generation: bootstrap.generation,
      }}
      clearFilters={() => {
        ui.setFilter("all");
        if (ui.view === "library") ui.setLibraryReadiness("all");
        ui.setQuery("");
      }}
      loading={!data.catalog}
      nativeSourceDrag={nativeSourceDrag}
    />
  );
}

function installedSteamBatchPorts(data: DataState, model: ReturnType<typeof useAppModel>) {
  return (data.catalog?.ports ?? []).filter((port) => model.statusMap.get(port.id)?.active);
}

function SelectedPortPanel({
  model,
  ui,
  operations,
  sourceHealth,
  installPlanning,
  backups,
  activities,
  libraryGeneration,
  refreshAfterMutation,
  openSourceIntake,
  openHostTool,
  openLibraryStorage,
  close,
}: {
  model: ReturnType<typeof useAppModel>;
  ui: UiState;
  operations: OperationState;
  sourceHealth: SourceHealthState;
  installPlanning: InstallPlanningState;
  backups: BackupState;
  activities: ActivityRecord[];
  libraryGeneration: number;
  refreshAfterMutation: () => void;
  openSourceIntake: (portId: string, profileId: string, paths?: string[]) => void;
  openHostTool: (toolId: string) => void;
  openLibraryStorage: () => void;
  close: () => void;
}) {
  if (!model.port) return null;
  const pickSource = model.sourceProfile
    ? () => {
        return applyPathChoice(
          pickSourcePath(model.sourceProfile!, ui.sourcePath),
          ui.setSourcePath,
          operations.setError,
        );
      }
    : undefined;
  const pickArchive =
    model.sourceProfile?.kind === "file-set" || model.sourceProfile?.kind === "relative-file-set"
      ? () => {
          void applyPathChoice(
            pickSourceArchivePath(ui.sourcePath),
            ui.setSourcePath,
            operations.setError,
          );
        }
      : undefined;
  const pickBios = model.biosProfile
    ? () => {
        return applyPathChoice(
          pickSourcePath(model.biosProfile!, ui.biosPath, "bios"),
          ui.setBiosPath,
          operations.setError,
        );
      }
    : undefined;
  return (
    <DetailPanel
      perform={operations.perform}
      prepare={(expectedPlan, onEvent) =>
        operations.perform(
          "prepare game data",
          () => desktopApi.prepare(model.port.id, expectedPlan, libraryGeneration, onEvent),
          {
            context: {
              action: "Prepare game data",
              target: { kind: "port", id: model.port.id, label: gameIdentityLabel(model.port) },
              libraryGeneration,
              exclusionScope: "target",
            },
          },
        )
      }
      port={model.port}
      status={model.status}
      installPlan={installPlanning.plan}
      backups={backups.backups}
      backupProblems={backups.inventory.problems}
      backupState={backups.inventory.state}
      backupCreateAssessment={backups.inventory.create_assessment}
      backupRestoreAssessment={backups.inventory.restore_assessment}
      backupReadState={backups.readState}
      retryBackupRead={backups.refresh}
      source={model.source}
      sourceInspection={
        model.port.source_profile
          ? sourceHealth.inspections.get(model.port.source_profile)
          : undefined
      }
      sourceProfile={model.sourceProfile}
      sourcePath={ui.sourcePath}
      setSourcePath={ui.setSourcePath}
      cancellableActivities={activities.filter(
        (activity) => activity.target_id === model.port?.id && activity.cancellation,
      )}
      libraryGeneration={libraryGeneration}
      gameFileQueryContext={model.gameFileQueryContext}
      gameFileFilterContext={model.gameFileQuery?.context}
      gameFileObservation={model.gameFileQuery?.observation}
      browsingMatch={model.browsingMatch}
      browsingBinding={model.queryContext.browsing?.workspace_binding_sha256}
      outputLocationChanged={installPlanning.invalidate}
      externalRuntimeChanged={() => {
        installPlanning.invalidate();
        refreshAfterMutation();
      }}
      pickSource={pickSource}
      pickSourceArchive={pickArchive}
      busy={operations.busy}
      bios={model.bios}
      biosInspection={
        model.port.bios_source_profile
          ? sourceHealth.inspections.get(model.port.bios_source_profile)
          : undefined
      }
      biosProfile={model.biosProfile}
      biosPath={ui.biosPath}
      setBiosPath={ui.setBiosPath}
      pickBios={pickBios}
      openSourceEvidence={(evidenceId) => {
        void operations.perform(
          "open source evidence",
          () => desktopApi.openSourceEvidence(evidenceId),
          { refresh: "none", invalidateDiagnostics: false },
        );
      }}
      inspectSource={(profile) => {
        const path = profile.id === model.port.bios_source_profile ? ui.biosPath : ui.sourcePath;
        openSourceIntake(model.port.id, profile.id, path.trim() ? [path] : []);
      }}
      openHostTool={openHostTool}
      openLibraryStorage={openLibraryStorage}
      actions={detailActions({
        port: model.port,
        status: model.status,
        sourcePath: ui.sourcePath,
        biosPath: ui.biosPath,
        perform: operations.perform,
        close: close,
        reviewInstall: installPlanning.review,
        backupsChanged: backups.refresh,
        libraryGeneration: libraryGeneration,
        dismissInstallReview: installPlanning.invalidate,
      })}
    />
  );
}

function AdoptionOverlay({
  ui,
  operations,
  libraryGeneration,
  ports,
}: {
  ui: UiState;
  operations: OperationState;
  libraryGeneration: number;
  ports: readonly PortDefinition[];
}) {
  const finish = () => {
    ui.setAdoptOpen(false);
    ui.setAdoptPath("");
  };
  const planning = useAdoptionPlanning(
    ui.adoptPath,
    ui.selectedId,
    ui.adoptOpen,
    libraryGeneration,
    operations.perform,
    finish,
    ports,
  );
  const setPath = (path: string) => {
    planning.invalidate();
    ui.setAdoptPath(path);
  };
  if (!ui.adoptOpen) return null;
  return (
    <AdoptionModal
      path={ui.adoptPath}
      setPath={setPath}
      ports={ports}
      preview={planning.preview}
      copyFailed={planning.copyFailed}
      applying={planning.applying}
      busy={operations.busy}
      close={() => {
        planning.invalidate();
        ui.setAdoptOpen(false);
      }}
      pickFolder={() => {
        void applyPathChoice(pickInstallFolder(ui.adoptPath), setPath, operations.setError);
      }}
      review={(selectedPortId) => {
        void planning.review(selectedPortId);
      }}
      adopt={() => {
        void planning.adopt();
      }}
    />
  );
}

async function applyPathChoice(
  choice: Promise<string | null>,
  setPath: (path: string) => void,
  setError: (error?: string) => void,
) {
  try {
    const path = await choice;
    if (path) setPath(path);
  } catch (value) {
    setError(errorText(value));
  }
}

function sourcePickerPurpose(
  profileId: string,
  ports: readonly PortDefinition[],
): SourcePickerPurpose {
  return ports.some((port) => port.bios_source_profile === profileId) ? "bios" : "game";
}

function usePendingHostToolFocus(
  data: DataState,
  view: UiState["view"],
  pendingToolId: string | undefined,
  setPendingToolId: (value: string | undefined) => void,
) {
  useEffect(() => {
    if (
      !pendingToolId ||
      view !== "settings" ||
      (!data.doctor && (!data.diagnosticFailure || data.diagnosticRefreshing))
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById("disc-tools-heading");
      if (document.activeElement !== heading && document.activeElement !== document.body) {
        setPendingToolId(undefined);
        return;
      }
      focusDiscTool(pendingToolId);
      setPendingToolId(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    data.diagnosticFailure,
    data.diagnosticRefreshing,
    data.doctor,
    pendingToolId,
    setPendingToolId,
    view,
  ]);
}

function useWorkspaceApplicationUpdates(reportError: OperationState["setError"]) {
  const applicationUpdate = useApplicationUpdateNotice(reportError);
  const applicationUpdateChoice = useApplicationUpdateChoice(reportError);
  const applicationUpdateProductionTransition = useApplicationUpdateProductionTransition({
    preferences: applicationUpdateChoice.preferences,
    acceptPreferences: applicationUpdateChoice.accept,
    refreshPreferences: applicationUpdateChoice.refresh,
    reportError: reportError,
  });
  return { applicationUpdate, applicationUpdateChoice, applicationUpdateProductionTransition };
}
