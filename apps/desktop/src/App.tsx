import { Heart } from "lucide-react";
import { gameGroupId } from "./features/browsing/original-game";
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
import { ActionRow, Notice } from "./components/ui/patterns";
import { updateNoticeHidden } from "./features/organization/organization";
import { useOrganization } from "./features/organization/use-organization";
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
import type { DetailOpening } from "./features/game-details/detail-sections";
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
  WorkspaceToolbar,
  type HostToolActions,
} from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { DetailPanel } from "./components/DetailPanel";
import { GameAlternatives } from "./features/browsing/GameAlternatives";
import { PortBrowser, SteamBatchLibraryAction } from "./components/PortBrowser";
import { ListingDetailPanel } from "./components/ListingDetailPanel";
import { SelfServiceSetup } from "./components/SelfServiceSetup";
import { catalogEntries, usesSelfServiceDetail } from "./features/browsing/catalog-entry";
import { evaluateCatalogQuery, type CatalogQueryContext } from "./features/browsing/catalog-query";
import {
  useGameFileFilterContext,
  type GameFileFilterState,
} from "./features/browsing/use-game-file-filter-context";
import { ArtworkProvider } from "./artwork";
import { SourceIntakeDialog } from "./components/SourceIntake";
import { UpdateCenter } from "./components/UpdateCenter";
import { FailureDetails } from "./components/FailureDetails";
import { SupportBundleExport } from "./components/SupportBundleExport";
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
import { gameIdentityLabel, gameTitle } from "./port-identity";
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
        key={bootstrap.generation}
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
    <main className="bootstrap-state bootstrap-error startup-recovery">
      <header className="startup-recovery-heading">
        <p className="eyebrow">Startup recovery</p>
        <h1>Portcove couldn’t start</h1>
        <p className="text-pc-muted-foreground" role="alert">
          {errorText(error)}
        </p>
      </header>
      {error.presentation ? (
        <FailureDetails
          presentation={error.presentation}
          code={error.code}
          contextLabel={startupDetailLabel}
        />
      ) : (
        <StartupTechnicalDetails error={error} />
      )}
      {(recoveryRoot || importRoot) && (
        <section className="startup-recovery-resolution" aria-label="Unfinished library change">
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
        </section>
      )}
      <p className="[&:not(.eyebrow)]:text-[var(--color-text-muted)]">
        {recoveryRoot || importRoot
          ? "Review the recovery above first. Retry startup after resolving the unfinished transfer, or choose a different library."
          : "Review the error details, then retry startup. If the current library is the cause, choose another library or return to the platform default."}
      </p>
      <ActionRow aria-busy={pending}>
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
      </ActionRow>
      {actionError && (
        <p className="[&:not(.eyebrow)]:text-[var(--color-text-muted)]" role="alert">
          {actionError}
        </p>
      )}
      <section
        aria-label="Support bundle"
        className="grid min-w-0 gap-3 border-t border-pc-border pt-4"
        data-focus-group
      >
        <h2>Create support bundle</h2>
        <SupportBundleExport
          disabled={pending}
          createSupportBundle={desktopApi.createSupportBundle}
        />
      </section>
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

type WorkspaceProps = {
  bootstrap: BootstrapStatus;
  initialBrowsingContext?: LibraryBrowsingContext | undefined;
  rememberBrowsingContext: (root: string, context: LibraryBrowsingContext) => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  returnToSelection?: "switch" | "reset" | undefined;
  consumeLibrarySelectionReturn: () => void;
};

function useWorkspace(props: WorkspaceProps) {
  const { bootstrap, returnToSelection, consumeLibrarySelectionReturn } = props;
  const {
    data,
    collection,
    favorites,
    organization,
    setupSource,
    setSetupSource,
    operations,
    github,
    updates,
    ui,
    switchView,
    workspace,
    switchLibraryWithContext,
    resetLibraryWithContext,
    preferenceFailure,
    saveBrowsingPreferences,
  } = useWorkspaceLibrary(props);
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
  const selectedPort = data.statuses.some(
    (status) => status.port_id === ui.selectedId && status.external_runtime?.user_selected,
  )
    ? undefined
    : data.catalog?.ports.find((port) => port.id === ui.selectedId);
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
    `${bootstrap.generation}|${JSON.stringify(data.catalog?.source_catalog ?? null)}`,
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
  usePendingSetupReview(
    setupReviews,
    ui.selectedId,
    model.port?.id,
    model.status,
    data.refreshFailure,
    installPlanning.review,
  );
  const backups = usePortBackups(model.port?.id);
  useLibrarySelectionLanding(returnToSelection, workspace, consumeLibrarySelectionReturn);
  const { adoptOpen, selectedId, setAdoptOpen, setSelectedId, setView } = ui;
  const availablePortIds = useMemo(
    () => (data.catalog ? new Set(model.entries.map((port) => port.id)) : undefined),
    [data.catalog, model.entries],
  );
  const {
    close: closePortDetails,
    invalidate: invalidatePortDetails,
    open: openPortDetails,
    replace: switchPortDetails,
    opening: detailOpening,
  } = useDetailWorkspaceNavigation(workspace, setSelectedId, availablePortIds);
  const [pendingToolId, setPendingToolId] = useState<string>();
  const [addGamesOpen, setAddGamesOpen] = useState(false);
  const [addGamesStarted, setAddGamesStarted] = useState(false);
  const [organizationViews, setOrganizationViews] = useState({ library: "all", catalog: "all" });
  const organizationKey = ui.view === "catalog" ? "catalog" : "library";
  const setOrganizationView = (value: string) =>
    setOrganizationViews((current) => ({ ...current, [organizationKey]: value }));
  const selectLibraryCollection = (value: string) => {
    setOrganizationViews((current) => ({ ...current, library: value }));
    setAddGamesOpen(false);
    setPrimaryView("library");
  };
  const detailBackLabel =
    addGamesOpen && detailOpening?.originKey?.startsWith("add-games:")
      ? "Back to Add games"
      : detailOpening?.originKey?.startsWith("library:")
        ? "Back to Library"
        : detailOpening?.originKey?.startsWith("catalog:")
          ? "Back to Discover"
          : undefined;
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
  const controller = useGamepadNavigation(handleBack, (offset) => {
    const destinations = ["library", "catalog", "updates", "settings"] as const;
    const index = destinations.indexOf(ui.view);
    setPrimaryView(destinations[(index + offset + destinations.length) % destinations.length]!);
    focusRegion("sidebar");
  });
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
    !model.entry &&
    (addGamesOpen && ui.view === "library" ? (
      <h1 tabIndex={-1}>Add games</h1>
    ) : (
      <PageHeader
        view={ui.view}
        query={ui.query}
        setQuery={ui.setQuery}
        portCount={model.entries.length}
        libraryCount={data.catalog ? model.overview.installed : undefined}
        onAddGames={
          ui.view === "library" && model.overview.installed > 0 ? openAddGames : undefined
        }
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
  const implementationControl = model.entry && (
    <GameAlternatives
      port={model.entry}
      ports={model.entries.filter(
        (candidate) => gameGroupId(candidate) === gameGroupId(model.entry!),
      )}
      statuses={model.statusMap}
      organization={organization}
      onSelect={(portId) => switchPortDetails(portId)}
    />
  );
  const renderWorkspaceView = () =>
    model.entry && usesSelfServiceDetail(model.entry, model.status) ? (
      <ListingDetailPanel
        backLabel={detailBackLabel}
        libraryRoot={bootstrap.library_root ?? undefined}
        organization={organization}
        openSupport={() => {
          ui.setSettingsCategory("advanced");
          setPrimaryView("settings");
        }}
        key={model.entry.id}
        opening={detailOpening}
        entry={model.entry}
        groupPorts={model.entries.filter(
          (candidate) => gameGroupId(candidate) === gameGroupId(model.entry!),
        )}
        implementationControl={implementationControl}
        favoriteControl={
          model.status?.external_runtime
            ? renderSelectedPortFavoriteControl({
                favorites,
                favoritePortId: model.entry.id,
                displayPort: model.entry,
              })
            : undefined
        }
        status={model.status}
        generation={bootstrap.generation}
        perform={operations.perform}
        onChanged={() => {
          void data.refreshAfterMutation();
        }}
        close={closePortDetails}
      />
    ) : model.port ? (
      <>
        <SelectedPortPanel
          implementationControl={implementationControl}
          backLabel={detailBackLabel}
          favorites={favorites}
          extraFiles={
            model.entry?.listing &&
            !model.status?.active &&
            !model.status?.staged &&
            !model.status?.external_runtime && (
              <details className="mt-6 border-t border-pc-border pt-4">
                <summary data-focusable className="cursor-pointer font-medium">
                  Use an existing installation · Installation options
                </summary>
                <div className="mt-4">
                  <SelfServiceSetup
                    libraryRoot={bootstrap.library_root ?? undefined}
                    key={`${model.entry.id}:${bootstrap.generation}`}
                    entry={model.entry}
                    status={model.status}
                    generation={bootstrap.generation}
                    perform={operations.perform}
                    onChanged={() => {
                      void data.refreshAfterMutation();
                    }}
                  />
                </div>
              </details>
            )
          }
          organization={organization}
          openSupport={() => {
            ui.setSettingsCategory("advanced");
            setPrimaryView("settings");
          }}
          openActivity={() => setPrimaryView("updates")}
          opening={detailOpening}
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
      </>
    ) : addGamesOpen && ui.view === "library" ? null : (
      <CurrentView
        onAddGames={openAddGames}
        collection={collection}
        organization={organization}
        organizationSelection={{
          value: organizationViews[organizationKey],
          onChange: setOrganizationView,
        }}
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
  return {
    bootstrap,
    data,
    organization,
    organizationViews,
    selectLibraryCollection,
    setupSource,
    setSetupSource,
    operations,
    ui,
    workspace,
    applicationUpdate,
    applicationUpdateChoice,
    applicationUpdateProductionTransition,
    openSourceIntake,
    model,
    openPortDetails,
    addGamesOpen,
    addGamesStarted,
    setPrimaryView,
    closeAddGames,
    commandSurface,
    controller,
    reviewApplicationUpdate,
    dismissApplicationUpdateChoice,
    completeApplicationUpdateProductionTransition,
    dismissApplicationUpdateProductionTransition,
    renderPageHeader,
    renderPreferenceFailure,
    renderWorkspaceView,
    renderSourceIntake,
  };
}

function Workspace(props: Parameters<typeof useWorkspace>[0]) {
  return <WorkspaceView {...useWorkspace(props)} />;
}

function WorkspaceView({ workspace, ...model }: ReturnType<typeof useWorkspace>) {
  return (
    <OperationPresentationProvider
      generation={model.bootstrap.generation}
      pending={model.operations.pendingOperations}
    >
      <ArtworkProvider
        generation={model.bootstrap.generation}
        catalog={model.data.catalog}
        listings={model.data.listingCatalog}
      >
        <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)] bg-[var(--color-bg)]">
          <Sidebar
            view={model.ui.view}
            setView={model.setPrimaryView}
            controller={model.controller}
            installedCount={model.model.overview.installed}
            updateCount={
              model.data.statuses.filter((status) => {
                const check = currentUpdateSnapshot(status)?.check;
                const release = check?.release;
                return (
                  check?.update_available &&
                  !updateNoticeHidden(
                    model.organization.snapshot?.update_notices[status.port_id],
                    release?.asset.sha256
                      ? { version: release.version, artifact_sha256: release.asset.sha256 }
                      : undefined,
                  )
                );
              }).length
            }
            activities={model.data.activities}
            organization={model.organization}
            collectionView={model.organizationViews.library}
            onSelectCollection={model.selectLibraryCollection}
            libraryRoot={model.bootstrap.library_root ?? undefined}
            collectionActions={
              installedSteamBatchPorts(model.data, model.model).length >= 2 ? (
                <SteamBatchLibraryAction
                  ports={installedSteamBatchPorts(model.data, model.model)}
                  generation={model.bootstrap.generation}
                />
              ) : undefined
            }
          />
          <main
            className="workspace-main min-h-0 w-full min-w-0 overflow-auto pb-12 max-[75rem]:pb-10"
            ref={workspace}
            data-focus-region="workspace"
            data-workspace-continuity-scope={JSON.stringify([
              model.bootstrap.generation,
              model.ui.view,
              model.model.entry?.id ?? null,
              model.addGamesOpen,
            ])}
            tabIndex={-1}
          >
            <WorkspaceToolbar
              view={model.ui.view}
              detailTitle={model.model.entry ? gameTitle(model.model.entry) : undefined}
              onOpenCommands={() => model.commandSurface.setOpen(true)}
            />
            <div
              className={
                !model.model.entry &&
                (model.ui.view === "catalog" ||
                  (model.ui.view === "library" && !model.addGamesOpen))
                  ? "w-full min-w-0"
                  : "w-full max-w-(--layout-content-max) min-w-0"
              }
            >
              {model.renderPageHeader()}
              <div className="flow-root min-w-0" data-workspace-feedback>
                <StatusLayer
                  invocations={model.operations.invocations}
                  operationEvents={model.operations.operationEvents}
                  dismissInvocation={model.operations.dismissInvocation}
                  openActivity={(id) => {
                    model.ui.setReviewedActivityId(id);
                    model.setPrimaryView("updates");
                  }}
                  error={model.operations.error}
                  clearError={() => model.operations.setError(undefined)}
                  reviewCurrentState={model.data.retryRefresh}
                  preparationRecovery={(record) => {
                    const id = preparationRecoveryPort(
                      record.failure,
                      model.data.catalog?.ports ?? [],
                      model.data.statuses,
                    );
                    return id
                      ? () => model.openPortDetails(id, "error:preparation-review")
                      : undefined;
                  }}
                  operation={model.operations.operation}
                  busy={model.operations.busy}
                  featureNotices={
                    <ApplicationUpdateNotices
                      updateNotice={model.applicationUpdate.notice}
                      updateChoiceRequired={model.applicationUpdateChoice.choiceRequired}
                      productionTransitionRequired={
                        model.applicationUpdateProductionTransition.offerRequired
                      }
                      productionTransitionBusy={model.applicationUpdateProductionTransition.busy}
                      reviewUpdate={model.reviewApplicationUpdate}
                      dismissUpdate={model.applicationUpdate.dismiss}
                      dismissUpdateChoice={model.dismissApplicationUpdateChoice}
                      useStable={() =>
                        void model.completeApplicationUpdateProductionTransition("use-stable")
                      }
                      keepPreview={() =>
                        void model.completeApplicationUpdateProductionTransition("keep-preview")
                      }
                      dismissProductionTransition={
                        model.dismissApplicationUpdateProductionTransition
                      }
                    />
                  }
                />
                <WorkspaceRefreshNotice
                  failure={model.data.refreshFailure}
                  recoveryFailure={model.data.recoveryFailure}
                  hasSnapshot={Boolean(model.data.catalog)}
                  refreshing={model.data.refreshing}
                  retry={model.data.retryRefresh}
                  retryRecovery={model.data.retryRecovery}
                  subscriptionFailure={
                    model.data.subscriptionFailure?.error ?? model.operations.subscriptionFailure
                  }
                />
                {model.renderPreferenceFailure()}
              </div>
              {model.renderWorkspaceView()}
              {model.addGamesStarted && (
                <AddGames
                  key={model.bootstrap.generation}
                  active={model.addGamesOpen && model.ui.view === "library" && !model.model.entry}
                  generation={model.bootstrap.generation}
                  ports={model.data.catalog?.ports ?? []}
                  profiles={model.data.catalog?.source_profiles ?? []}
                  statuses={model.model.statusMap}
                  sources={model.data.sources}
                  refreshFailed={Boolean(model.data.refreshFailure)}
                  onAdded={model.data.refreshAfterMutation}
                  onOpenPort={model.openPortDetails}
                  onCheckFiles={model.openSourceIntake}
                  onBrowseCatalog={() => model.setPrimaryView("catalog")}
                  onCopyInstallation={() => model.ui.setAdoptOpen(true)}
                  setupSource={model.setupSource}
                  setSetupSource={model.setSetupSource}
                  close={model.closeAddGames}
                />
              )}
            </div>
          </main>
          <AdoptionOverlay
            ui={model.ui}
            operations={model.operations}
            libraryGeneration={model.bootstrap.generation}
            ports={model.data.catalog?.ports ?? []}
          />
          <CommandPalette
            open={model.commandSurface.open}
            commands={model.commandSurface.commands}
            close={() => model.commandSurface.setOpen(false)}
          />
          {model.renderSourceIntake()}
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
  const { catalog, sources, statuses, browsing, listingCatalog, listingStatuses, pendingSetups } =
    data;
  const entries = useMemo(
    () => catalogEntries(catalog, listingCatalog, listingStatuses, pendingSetups),
    [catalog, listingCatalog, listingStatuses, pendingSetups],
  );
  const statusMap = useMemo(
    () => indexStatuses([...listingStatuses.map(({ status }) => status), ...statuses]),
    [statuses, listingStatuses],
  );
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
            catalogUniverse: entries,
            gameFiles: gameFileQuery?.context,
            browsing: browsing ?? undefined,
            devicePlatform: browsing?.host_platform,
          }
        : {},
    [catalog, libraryRoot, statusMap, gameFileQuery?.context, browsing, entries],
  );
  const visible = useMemo(
    () =>
      filterPorts(
        ui.view === "library"
          ? ["all", "ready", "setup"].includes(ui.libraryReadiness)
            ? filterPorts(
                entries,
                statusMap,
                "library",
                ui.libraryReadiness as "all" | "ready" | "setup",
                "",
              )
            : []
          : entries,
        statusMap,
        ui.view,
        ui.filter,
        ui.query,
        ui.view === "library" ? ui.librarySort : ui.catalogSort,
        queryContext,
      ),
    [
      entries,
      statusMap,
      ui.view,
      ui.filter,
      ui.libraryReadiness,
      ui.query,
      ui.catalogSort,
      ui.librarySort,
      queryContext,
    ],
  );
  const catalogFilterCandidates = useMemo(
    () => (ui.view === "catalog" && data.catalog ? entries : undefined),
    [data.catalog, entries, ui.view],
  );
  const libraryFilterCandidates = useMemo(
    () =>
      ui.view === "library" && data.catalog
        ? filterPorts(entries, statusMap, "library", "all", ui.query)
        : undefined,
    [data.catalog, entries, statusMap, ui.view, ui.query],
  );
  const overview = useMemo(() => summarizeLibrary(entries, statusMap), [entries, statusMap]);
  const recent = useMemo(() => mostRecentPort(entries, statusMap), [entries, statusMap]);
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
    entries,
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
    entry: entries.find((entry) => entry.id === selectedId),
    status: selectedId ? statusMap.get(selectedId) : undefined,
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

function launchKnownPort(
  portId: string,
  port: Parameters<typeof gameIdentityLabel>[0] | undefined,
  perform: OperationState["perform"],
  generation: BootstrapStatus["generation"],
) {
  if (!port) return;
  void perform("launch", () => desktopApi.launch(portId, "", generation), {
    context: {
      action: "Launch",
      operation: "launch",
      target: { kind: "port", id: portId, label: gameIdentityLabel(port) },
      libraryGeneration: generation,
      exclusionScope: "target",
    },
  });
}

function CurrentView({
  onAddGames,
  collection,
  favorites,
  organization,
  organizationSelection,
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
  organization: ReturnType<typeof useOrganization>;
  organizationSelection: { value: string; onChange: (value: string) => void };
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
        activityPorts={model.entries}
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
        onLaunch={(portId) =>
          launchKnownPort(
            portId,
            data.catalog?.ports.find((port) => port.id === portId),
            operations.perform,
            bootstrap.generation,
          )
        }
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
      <CurrentSettingsView
        data={data}
        ui={ui}
        model={model}
        operations={operations}
        github={github}
        sourceHealth={sourceHealth}
        appearance={appearance}
        bootstrap={bootstrap}
        switchLibrary={switchLibrary}
        resetLibrary={resetLibrary}
        hostToolActions={hostToolActions}
        applicationUpdates={applicationUpdates}
        openPortDetails={openPortDetails}
        setupSource={setupSource}
        setSetupSource={setSetupSource}
      />
    );
  if (!data.catalog && data.refreshFailure) return null;
  return (
    <PortBrowser
      collectionLayout={collection.value}
      setCollectionLayout={collection.set}
      collectionLayoutFailure={collection.failure}
      favorites={favorites}
      organization={organization}
      organizationSelection={organizationSelection}
      catalogUniverse={model.entries}
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
      setQuery={ui.setQuery}
      catalogSort={ui.view === "library" ? ui.librarySort : ui.catalogSort}
      setCatalogSort={ui.view === "library" ? ui.setLibrarySort : ui.setCatalogSort}
      setFilter={ui.setFilter}
      onSelect={openPortDetails}
      onContinue={(portId) =>
        launchKnownPort(
          portId,
          model.entries.find((port) => port.id === portId),
          operations.perform,
          bootstrap.generation,
        )
      }
      onTask={(activityId) => {
        ui.setReviewedActivityId(activityId);
        ui.setView("updates");
        ui.setActivitySection("tasks");
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus());
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

function CurrentSettingsView({
  data,
  ui,
  model,
  operations,
  github,
  sourceHealth,
  appearance,
  bootstrap,
  switchLibrary,
  resetLibrary,
  hostToolActions,
  applicationUpdates,
  openPortDetails,
  setupSource,
  setSetupSource,
}: Pick<
  Parameters<typeof CurrentView>[0],
  | "data"
  | "ui"
  | "model"
  | "operations"
  | "github"
  | "sourceHealth"
  | "appearance"
  | "bootstrap"
  | "switchLibrary"
  | "resetLibrary"
  | "hostToolActions"
  | "applicationUpdates"
  | "openPortDetails"
  | "setupSource"
  | "setSetupSource"
>) {
  return (
    <SettingsView
      steamPorts={installedSteamBatchPorts(data, model)}
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
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus());
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
          {
            refresh: "none",
            invalidateDiagnostics: false,
            cancelledResult: (result) => result === undefined,
          },
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
}

function installedSteamBatchPorts(data: DataState, model: ReturnType<typeof useAppModel>) {
  return (data.catalog?.ports ?? []).filter((port) => model.statusMap.get(port.id)?.active);
}

function renderSelectedPortFavoriteControl({
  favorites,
  favoritePortId,
  displayPort,
}: {
  favorites: ReturnType<typeof useFavorites>;
  favoritePortId: string;
  displayPort: Parameters<typeof gameIdentityLabel>[0];
}) {
  return (
    <>
      <Button
        data-focusable
        variant={favorites.ids?.has(favoritePortId) ? "selected" : "outline"}
        size="icon-lg"
        aria-label={`Favorite ${gameIdentityLabel(displayPort)}`}
        aria-pressed={favorites.ids?.has(favoritePortId) ?? false}
        disabled={!favorites.ids || favorites.busy}
        focusableWhenDisabled={Boolean(favorites.ids) && favorites.busy}
        aria-busy={favorites.busy}
        onClick={() => void favorites.toggle(favoritePortId)}
      >
        <Heart
          aria-hidden="true"
          fill={favorites.ids?.has(favoritePortId) ? "currentColor" : "none"}
        />
      </Button>
      {favorites.failure && (
        <span role="alert" className="max-w-prose text-sm text-pc-warning-foreground">
          {favorites.failure === "write"
            ? "The favorite change could not be confirmed. Refresh to reconcile."
            : "Favorites could not be loaded."}{" "}
          <Button
            variant="ghost"
            size="sm"
            disabled={favorites.busy}
            onClick={() => void favorites.refresh()}
          >
            Refresh favorites
          </Button>
        </span>
      )}
    </>
  );
}

function SelectedPortPanel({
  implementationControl,
  favorites,
  organization,
  openSupport,
  extraFiles,
  openActivity,
  opening,
  backLabel,
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
  implementationControl?: ReactNode;
  favorites: ReturnType<typeof useFavorites>;
  organization: ReturnType<typeof useOrganization>;
  openSupport: () => void;
  extraFiles?: ReactNode;
  openActivity: () => void;
  opening?: DetailOpening | undefined;
  backLabel?: string | undefined;
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
  const favoritePortId = model.port.id;
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
      backLabel={backLabel}
      favoriteControl={
        <>
          {implementationControl}
          {renderSelectedPortFavoriteControl({
            favorites,
            favoritePortId,
            displayPort: model.entry ?? model.port,
          })}
        </>
      }
      organization={organization}
      openSupport={openSupport}
      extraFiles={extraFiles}
      openActivity={openActivity}
      opening={opening}
      perform={operations.perform}
      prepare={(expectedPlan, onEvent) =>
        operations.perform(
          "prepare game data",
          (reportEvent) =>
            desktopApi.prepare(model.port.id, expectedPlan, libraryGeneration, (event) => {
              reportEvent?.(event);
              onEvent(event);
            }),
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
      displayPort={model.entry}
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

function usePendingSetupReview(
  selection: ReturnType<typeof useSetupReviewSelection>,
  selectedId: string | undefined,
  portId: string | undefined,
  status: ReturnType<typeof useAppModel>["status"],
  refreshFailure: unknown,
  reviewInstallation: ReturnType<typeof useInstallPlanning>["review"],
) {
  const { pendingReview, takeReview } = selection;
  useEffect(() => {
    const request = pendingReview;
    if (!request) return;
    // Consume once, including StrictMode replay, and never plan a different detail.
    const matches =
      selectedId === request.portId &&
      portId === request.portId &&
      status?.channel === request.channel &&
      !refreshFailure &&
      !status.active &&
      !status.external_runtime &&
      status.port_actions?.some(
        (action) => action.action === "install" && action.availability === "allowed",
      );
    if (takeReview(request) && matches) void reviewInstallation();
  }, [pendingReview, takeReview, selectedId, portId, status, refreshFailure, reviewInstallation]);
}

function useWorkspaceLibrary({
  bootstrap,
  initialBrowsingContext,
  rememberBrowsingContext,
  switchLibrary,
  resetLibrary,
  returnToSelection,
}: WorkspaceProps) {
  const data = usePortcoveData(bootstrap.generation);
  const favorites = useFavorites(bootstrap.generation);
  const organization = useOrganization(bootstrap.generation);
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
      ? new Set([
          ...data.statuses
            .filter((status) => status.active || status.external_runtime)
            .map((status) => status.port_id),
          ...data.listingStatuses
            .filter(({ status }) => status.active || status.external_runtime)
            .map(({ port_id }) => port_id),
          ...data.pendingSetups.map(({ port_id }) => port_id),
        ]).size
      : undefined,
    catalogCount: data.catalog
      ? new Set([
          ...data.catalog.ports.map(({ id }) => id),
          ...(data.listingCatalog?.listings.map(({ id }) => id) ?? []),
        ]).size
      : undefined,
  });
  const collection = useCollectionLayout(
    bootstrap.library_root,
    ui.view === "catalog" ? "catalog" : "library",
  );
  const { catalog, diagnosticRevision, diagnosticsStale, doctor, refreshDiagnostics } = data;
  useEffect(() => {
    if (
      catalog &&
      (ui.view === "settings" || ui.view === "updates") &&
      (diagnosticsStale || !doctor)
    )
      void refreshDiagnostics();
  }, [catalog, diagnosticRevision, diagnosticsStale, doctor, refreshDiagnostics, ui.view]);

  return {
    data,
    collection,
    favorites,
    organization,
    setupSource,
    setSetupSource,
    operations,
    github,
    updates,
    ui,
    switchView,
    workspace,
    switchLibraryWithContext,
    resetLibraryWithContext,
    preferenceFailure,
    saveBrowsingPreferences,
  };
}
