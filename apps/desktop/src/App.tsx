import {
  useApplicationUpdateChoice,
  useApplicationUpdateNotice,
  useApplicationUpdateProductionTransition,
} from "./features/application-update/use-application-update";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePortcoveData } from "./features/workspace/use-workspace-data";
import { useGithubAuth } from "./features/github-auth/use-github-auth";
import { useSourceHealth } from "./features/source-health/use-source-health";
import { useSourceIntakeState } from "./features/source-intake/use-source-intake-state";
import { usePortBackups } from "./features/backups/use-port-backups";
import { useUpdateCenter } from "./features/port-updates/use-update-center";
import { useOperationState, type Perform } from "./features/operations/use-operation-state";
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
import { focusAndReveal, focusRegion } from "./focus";
import { overlayBackAction } from "./overlay-stack";
import { useNativeSourceDrop } from "./native-source-drop";
import { useCommandSurface } from "./use-command-surface";
import type {
  ActivityRecord,
  BootstrapStatus,
  HostToolStatus,
  PortDefinition,
  SourceProfile,
  SourceRecord,
} from "./types";
import {
  currentUpdateSnapshot,
  errorText,
  filterPorts,
  indexStatuses,
  mostRecentPort,
  requiredSourceNeeds,
  summarizeLibrary,
} from "./view-model";

export const missingBootstrapError = {
  code: "state",
  message: "Portcove could not start, and no error details were provided.",
  details: {},
} as const;

export default function App() {
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
  const { bootstrap, bootstrapError, switchLibrary, chooseLibrary, resetLibrary } =
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
        chooseLibrary={chooseLibrary}
        resetLibrary={resetLibrary}
      />
    );
  if (!bootstrap) return <BootstrapLoading />;
  if (!bootstrap.ready)
    return (
      <BootstrapRecovery
        error={bootstrap.error ?? missingBootstrapError}
        chooseLibrary={chooseLibrary}
        resetLibrary={resetLibrary}
      />
    );
  return (
    <Workspace
      key={bootstrap.generation}
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
  );
}

function BootstrapLoading() {
  return (
    <main className="bootstrap-state" aria-live="polite">
      <p className="eyebrow">Portcove</p>
      <h1>Opening your Portcove library</h1>
      <p>Loading the catalog, recovery history, and release information.</p>
    </main>
  );
}

export function BootstrapRecovery({
  error,
  chooseLibrary,
  resetLibrary,
}: {
  error: StartupFailure;
  chooseLibrary?: () => Promise<void>;
  resetLibrary?: () => Promise<void>;
}) {
  const [actionError, setActionError] = useState<string>();
  useGamepadNavigation(() => {});
  const recoveryRoot = transferRecoveryRoot(error);
  const canKeepOriginal = transferRecoveryCanKeepOriginal(error);
  const importRoot = transferRecoveryRoot(error, "import_destination");
  return (
    <main className="bootstrap-state bootstrap-error" role="alert">
      <p className="eyebrow">Portcove could not start</p>
      <h1>Portcove couldn’t start</h1>
      <p>{errorText(error)}</p>
      {error.presentation ? (
        <FailureDetails
          presentation={error.presentation}
          code={error.code}
          contextLabel={startupDetailLabel}
        />
      ) : (
        <StartupTechnicalDetails error={error} />
      )}
      <p>
        Review the error details, then retry startup. If the current library is the cause, you can
        choose another library or return to the platform default.
      </p>
      <div className="button-row">
        <Button type="button" variant="primary" onClick={() => window.location.reload()}>
          Retry startup
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void chooseLibrary?.().catch((value) => setActionError(errorText(value)));
          }}
        >
          Choose library
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void resetLibrary?.().catch((value) => setActionError(errorText(value)));
          }}
        >
          Use platform default
        </Button>
      </div>
      {actionError && <p role="alert">{actionError}</p>}
      {recoveryRoot && (
        <LibraryMoveRecovery source={recoveryRoot} canKeepOriginal={canKeepOriginal} />
      )}
      {importRoot && <LibraryImportRecovery destination={importRoot} />}
    </main>
  );
}

function StartupTechnicalDetails({ error }: { error: StartupFailure }) {
  return (
    <details>
      <summary data-focusable>Technical details</summary>
      <dl>
        <div>
          <dt>Error code</dt>
          <dd>{error.code}</dd>
        </div>
        {Object.entries(error.details).map(([key, value]) => {
          const label = startupDetailLabel(key);
          return (
            <div key={key}>
              <dt>{label ?? <code>{key}</code>}</dt>
              <dd>{value}</dd>
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
  initialBrowsingContext?: LibraryBrowsingContext;
  rememberBrowsingContext: (root: string, context: LibraryBrowsingContext) => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  returnToSelection?: "switch" | "reset";
  consumeLibrarySelectionReturn: () => void;
}) {
  const data = usePortcoveData(bootstrap.generation);
  const operations = useOperationState({
    refresh: data.retryRefresh,
    refreshActivities: data.refreshActivities,
    invalidateDiagnostics: data.invalidateDiagnostics,
  });
  const github = useGithubAuth(operations.perform, operations.setError);
  const updates = useUpdateCenter(operations.perform, data.statuses);
  const { ui, switchView, workspace, switchLibraryWithContext, resetLibraryWithContext } =
    useLibraryBrowsingContext({
      root: bootstrap.library_root,
      initial: initialBrowsingContext,
      returnToSelection,
      remember: rememberBrowsingContext,
      switchLibrary,
      resetLibrary,
      ready: Boolean(data.catalog),
      installedCount: data.catalog
        ? data.statuses.filter((status) => status.active).length
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
  const applicationUpdate = useApplicationUpdateNotice(operations.setError);
  const applicationUpdateChoice = useApplicationUpdateChoice(operations.setError);
  const applicationUpdateProductionTransition = useApplicationUpdateProductionTransition({
    preferences: applicationUpdateChoice.preferences,
    acceptPreferences: applicationUpdateChoice.accept,
    refreshPreferences: applicationUpdateChoice.refresh,
    reportError: operations.setError,
  });
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
  const model = useAppModel(data, ui);
  const installPlanning = useInstallPlanning(
    model.port?.id,
    model.status?.channel ?? model.port?.channels[0],
    operations.perform,
  );
  const backups = usePortBackups(model.port?.id, operations.setError);
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
  const setPrimaryView = useCallback(
    (...args: Parameters<typeof setView>) => {
      const nextView = typeof args[0] === "function" ? args[0](ui.view) : args[0];
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
    [invalidatePortDetails, setSelectedId, setView, switchView, ui.view],
  );
  const commandSurface = useCommandSurface({
    recent: model.recent,
    installedCount: model.overview.installed,
    busy: Boolean(operations.busy),
    setView: setPrimaryView,
    setAdoptOpen: ui.setAdoptOpen,
    setSelectedId: (portId) => openPortDetails(portId, `command-trigger:${ui.view}`),
    checkAll: updates.checkAll,
  });
  const adopting = [...operations.pendingOperations.values()].includes("adopt");
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
  const reviewApplicationUpdate = () => {
    setPrimaryView("settings");
    window.requestAnimationFrame(() => {
      const heading = document.getElementById("application-update-settings-title");
      heading?.scrollIntoView({ block: "start" });
      const control = heading
        ?.closest(".application-update-settings")
        ?.querySelector<HTMLElement>("button:not(:disabled), a[href]");
      if (control) focusAndReveal(control);
      else heading?.focus({ preventScroll: true });
    });
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

  return (
    <ArtworkProvider generation={bootstrap.generation}>
      <div className="app-shell">
        <Sidebar
          view={ui.view}
          setView={setPrimaryView}
          controller={controller}
          installedCount={data.statuses.filter((status) => status.active).length}
          updateCount={
            data.statuses.filter((status) => currentUpdateSnapshot(status)?.check.update_available)
              .length
          }
          activities={data.activities}
          onAdopt={() => ui.setAdoptOpen(true)}
        />
        <main ref={workspace} data-focus-region="workspace" tabIndex={-1}>
          {!model.port && (
            <PageHeader
              view={ui.view}
              query={ui.query}
              setQuery={ui.setQuery}
              portCount={data.catalog?.ports.length ?? 0}
              onOpenCommands={() => commandSurface.setOpen(true)}
            />
          )}
          <StatusLayer
            error={operations.error}
            clearError={() => operations.setError(undefined)}
            operation={operations.operation}
            busy={operations.busy}
            updateNotice={applicationUpdate.notice}
            updateChoiceRequired={applicationUpdateChoice.choiceRequired}
            productionTransitionRequired={applicationUpdateProductionTransition.offerRequired}
            productionTransitionBusy={applicationUpdateProductionTransition.busy}
            reviewUpdate={reviewApplicationUpdate}
            dismissUpdate={applicationUpdate.dismiss}
            dismissUpdateChoice={dismissApplicationUpdateChoice}
            useStable={() => void completeApplicationUpdateProductionTransition("use-stable")}
            keepPreview={() => void completeApplicationUpdateProductionTransition("keep-preview")}
            dismissProductionTransition={dismissApplicationUpdateProductionTransition}
          />
          <WorkspaceRefreshNotice
            failure={data.refreshFailure}
            recoveryFailure={data.recoveryFailure}
            hasSnapshot={Boolean(data.catalog)}
            refreshing={data.refreshing}
            retry={data.retryRefresh}
            retryRecovery={data.retryRecovery}
            subscriptionFailure={data.subscriptionFailure?.error ?? operations.subscriptionFailure}
          />
          {model.port ? (
            <SelectedPortPanel
              model={model}
              ui={ui}
              operations={operations}
              sourceHealth={sourceHealth}
              installPlanning={installPlanning}
              backups={backups}
              activities={data.activities}
              libraryGeneration={bootstrap.generation}
              openSourceIntake={openSourceIntake}
              close={closePortDetails}
            />
          ) : (
            <CurrentView
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
              applicationUpdateNotice={applicationUpdate.notice}
              applicationUpdatePreferences={applicationUpdateChoice}
              openPortDetails={openPortDetails}
            />
          )}
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
        {sourceIntake && (
          <SourceIntakeDialog
            request={sourceIntake}
            close={closeSourceIntake}
            onAdded={data.refreshAfterMutation}
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
        )}
      </div>
    </ArtworkProvider>
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

function useAppModel(data: DataState, ui: UiState) {
  const { selectedId, setBiosPath, setSourcePath } = ui;
  const { catalog, sources, statuses } = data;
  const statusMap = useMemo(() => indexStatuses(statuses), [statuses]);
  const visible = useMemo(
    () =>
      filterPorts(
        data.catalog?.ports ?? [],
        statusMap,
        ui.view,
        ui.filter,
        ui.query,
        ui.catalogSort,
      ),
    [data.catalog, statusMap, ui.view, ui.filter, ui.query, ui.catalogSort],
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
  useEffect(() => {
    setSourcePath(selection.source?.path ?? "");
  }, [selectedId, selection.source?.path, setSourcePath]);
  useEffect(() => {
    setBiosPath(selection.bios?.path ?? "");
  }, [selectedId, selection.bios?.path, setBiosPath]);
  return { statusMap, visible, overview, recent, sourceNeeds, ...selection };
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
  applicationUpdateNotice,
  applicationUpdatePreferences,
  openPortDetails,
}: {
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
  applicationUpdateNotice: ReturnType<typeof useApplicationUpdateNotice>["notice"];
  applicationUpdatePreferences: ReturnType<typeof useApplicationUpdateChoice>;
  openPortDetails: (portId: string, originKey?: string) => void;
}) {
  if (ui.view === "updates")
    return (
      <UpdateCenter
        generation={bootstrap.generation}
        ports={data.catalog?.ports ?? []}
        sourceProfiles={data.catalog?.source_profiles ?? []}
        statuses={model.statusMap}
        activities={data.activities}
        activityFeed={data.activityFeed}
        outcomes={updates.outcomes}
        busy={operations.busy}
        repair={data.doctor?.repair}
        diagnosticsRefreshing={data.diagnosticRefreshing}
        diagnosticsStale={data.diagnosticsStale}
        diagnosticFailure={data.diagnosticFailure?.error}
        refreshDiagnostics={data.refreshDiagnostics}
        cleanupChanged={() =>
          Promise.allSettled([data.refresh(), data.refreshDiagnosticsAfterMutation()])
        }
        checkAll={() => {
          void updates.checkAll();
        }}
        onSelect={openPortDetails}
        onOpenSettings={(target) => {
          const group =
            target === "game-files"
              ? "game-files"
              : target === "catalog-updates"
                ? "updates"
                : "library-storage";
          ui.setView("settings");
          window.requestAnimationFrame(() => {
            const heading = document.getElementById(`settings-${group}-heading`);
            heading?.scrollIntoView({ block: "start" });
            const control = heading
              ?.closest("[data-settings-group]")
              ?.querySelector<HTMLElement>(
                target === "game-files"
                  ? "button:not(:disabled), a[href]"
                  : `[data-settings-control="${target}"]:not(:disabled)`,
              );
            if (control) focusAndReveal(control);
            else heading?.focus({ preventScroll: true });
          });
        }}
      />
    );
  if (ui.view === "settings")
    return (
      <SettingsView
        generation={bootstrap.generation}
        ports={data.catalog?.ports ?? []}
        doctor={data.doctor}
        storage={data.storage}
        github={github}
        busy={operations.busy}
        sources={data.sources}
        appearance={appearance}
        librarySelection={bootstrap.selection ?? undefined}
        chooseLibrary={pickLibraryFolder}
        switchLibrary={switchLibrary}
        resetLibrary={resetLibrary}
        sourceProfiles={data.catalog?.source_profiles ?? []}
        onSourceAdded={data.refreshAfterMutation}
        onCatalogChanged={data.refreshAfterMutation}
        hostToolActions={hostToolActions}
        applicationUpdateNotice={applicationUpdateNotice}
        applicationUpdatePreferences={applicationUpdatePreferences}
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
        sourceInspections={sourceHealth.inspections}
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
          );
        }}
      />
    );
  if (!data.catalog && data.refreshFailure) return null;
  return (
    <PortBrowser
      view={ui.view}
      ports={model.visible}
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
        void operations.perform("launch", () => desktopApi.launch(portId, ""));
      }}
      onBrowseCatalog={() => ui.setView("catalog")}
      steamBatch={{
        ports: installedSteamBatchPorts(data, model),
        generation: bootstrap.generation,
      }}
      clearFilters={() => {
        ui.setFilter("all");
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
  openSourceIntake,
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
  openSourceIntake: (portId: string, profileId: string, paths?: string[]) => void;
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
    model.sourceProfile?.kind === "file-set"
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
        operations.perform("prepare game data", () =>
          desktopApi.prepare(model.port.id, expectedPlan, libraryGeneration, onEvent),
        )
      }
      port={model.port}
      status={model.status}
      installPlan={installPlanning.plan}
      backups={backups.backups}
      backupProblems={backups.inventory.problems}
      backupState={backups.inventory.state}
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
      outputLocationChanged={installPlanning.invalidate}
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
      inspectSource={(profile) => openSourceIntake(model.port.id, profile.id)}
      actions={detailActions(
        model.port,
        model.status,
        ui.sourcePath,
        ui.biosPath,
        operations.perform,
        close,
        installPlanning.review,
        backups.refresh,
        libraryGeneration,
        installPlanning.invalidate,
      )}
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

async function replaceRegisteredSource(
  profile: SourceProfile | undefined,
  source: SourceRecord,
  purpose: SourcePickerPurpose,
  perform: Perform,
  setError: (error?: string) => void,
) {
  if (!profile) {
    setError("The selected file’s source requirements are missing from the current catalog.");
    return;
  }
  try {
    const path = await pickSourcePath(profile, source.path, purpose);
    if (path)
      await perform("relink source", async () => {
        const plan = await desktopApi.planSourceRelink(profile.id, path);
        return desktopApi.relinkSource(profile.id, path, plan.preview_sha256);
      });
  } catch (value) {
    setError(errorText(value));
  }
}

async function addRequiredSource(
  profile: SourceProfile,
  archive: boolean,
  purpose: SourcePickerPurpose,
  perform: Perform,
  setError: (error?: string) => void,
) {
  try {
    const path = await (archive
      ? pickSourceArchivePath("", purpose)
      : pickSourcePath(profile, "", purpose));
    if (path) await perform("add source", () => desktopApi.addSource(profile.id, path));
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
