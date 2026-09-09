import { useCallback, useEffect, useMemo, useState } from "react";
import { AdoptionModal } from "./components/AdoptionModal";
import { LibraryMoveRecovery, transferRecoveryRoot } from "./components/LibraryMove";
import { LibraryImportRecovery } from "./components/LibraryImport";
import { PageHeader, SettingsView, Sidebar, StatusLayer, type HostToolActions } from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { DetailPanel } from "./components/DetailPanel";
import { PortBrowser } from "./components/PortBrowser";
import { SourceIntakeDialog, type SourceIntakeRequest } from "./components/SourceIntake";
import { UpdateCenter } from "./components/UpdateCenter";
import { FailureDetails } from "./components/FailureDetails";
import { pickHostToolExecutable, pickInstallFolder, pickLibraryFolder, pickMetadataExportPath, pickSourceArchivePath, pickSourcePath } from "./file-picker";
import { desktopApi } from "./api";
import { useWorkspaceScroll } from "./keyboard-shortcuts";
import { useThemePreference } from "./theme";
import { useGamepadNavigation } from "./gamepad";
import { focusRegion } from "./focus";
import { overlayBackAction } from "./overlay-stack";
import { useNativeSourceDrop } from "./native-source-drop";
import { useCommandSurface } from "./use-command-surface";
import { useAdoptionPlanning, detailActions, type Perform, useGithubAuth, useInstallPlanning, useOperationState, usePortBackups, usePortcoveData, usePortcoveUi, useSourceHealth, useUpdateCenter } from "./use-portcove";
import type { ActivityRecord, BootstrapStatus, DesktopError, HostToolStatus, SourceProfile, SourceRecord } from "./types";
import { currentUpdateSnapshot, errorText, failurePresentation, filterPorts, indexStatuses, mostRecentPort, requiredSourceNeeds, summarizeLibrary } from "./view-model";

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus>();
  const [bootstrapError, setBootstrapError] = useState<StartupFailure>();
  useEffect(() => {
    desktopApi.bootstrapStatus().then(setBootstrap).catch(value => {
      setBootstrapError(failurePresentation(value) ? value as DesktopError : { code: "state", message: errorText(value), details: {} });
    });
  }, []);
  const switchLibrary = async (path: string) => {
    const next = await desktopApi.setDefaultLibrary(path);
    setBootstrap(next);
    setBootstrapError(undefined);
  };
  const chooseLibrary = async (currentPath = "") => {
    const path = await pickLibraryFolder(currentPath);
    if (path) await switchLibrary(path);
  };
  const resetLibrary = async () => {
    const next = await desktopApi.resetDefaultLibrary();
    setBootstrap(next);
    setBootstrapError(undefined);
  };
  if (bootstrapError) return <BootstrapRecovery error={bootstrapError} chooseLibrary={chooseLibrary} resetLibrary={resetLibrary} />;
  if (!bootstrap) return <BootstrapLoading />;
  if (!bootstrap.ready) return <BootstrapRecovery error={bootstrap.error ?? { code: "state", message: "Portcove initialization failed without an error report.", details: {} }} chooseLibrary={chooseLibrary} resetLibrary={resetLibrary} />;
  return <Workspace key={bootstrap.generation} bootstrap={bootstrap} switchLibrary={switchLibrary} resetLibrary={resetLibrary} />;
}

function BootstrapLoading() {
  return <main className="bootstrap-state" aria-live="polite">
    <p className="eyebrow">Portcove</p>
    <h1>Opening your native library</h1>
    <p>Loading the catalog, recovery journal, and release providers.</p>
  </main>;
}

type StartupFailure = Pick<DesktopError, "code" | "message" | "details"> & Partial<Pick<DesktopError, "presentation">>;

export function BootstrapRecovery({ error, chooseLibrary, resetLibrary }: { error: StartupFailure; chooseLibrary?: () => Promise<void>; resetLibrary?: () => Promise<void> }) {
  const [actionError, setActionError] = useState<string>();
  useGamepadNavigation(() => {});
  const recoveryRoot = transferRecoveryRoot(error);
  const importRoot = transferRecoveryRoot(error, "import_destination");
  return <main className="bootstrap-state bootstrap-error" role="alert">
    <p className="eyebrow">Portcove could not start</p>
    <h1>Your library needs attention</h1>
    <p>{errorText(error)}</p>
    {error.presentation ? <FailureDetails presentation={error.presentation} code={error.code} /> : <dl>
      <div><dt>Error code</dt><dd>{error.code}</dd></div>
      {Object.entries(error.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>}
    <p>Check the configured library path, access permissions, and available space, then retry. Portcove will run recovery checks again before enabling library actions.</p>
    <div className="button-row">
      <button type="button" onClick={() => window.location.reload()}>Retry startup</button>
      <button type="button" onClick={() => { void chooseLibrary?.().catch(value => setActionError(errorText(value))); }}>Choose library</button>
      <button type="button" onClick={() => { void resetLibrary?.().catch(value => setActionError(errorText(value))); }}>Use platform default</button>
    </div>
    {actionError && <p role="alert">{actionError}</p>}
    {recoveryRoot && <LibraryMoveRecovery source={recoveryRoot} />}
    {importRoot && <LibraryImportRecovery destination={importRoot} />}
  </main>;
}

function Workspace({ bootstrap, switchLibrary, resetLibrary }: { bootstrap: BootstrapStatus; switchLibrary: (path: string) => Promise<void>; resetLibrary: () => Promise<void> }) {
  const data = usePortcoveData();
  const operations = useOperationState(data.refresh);
  const github = useGithubAuth(operations.perform, operations.setError);
  const updates = useUpdateCenter(operations.perform, data.statuses);
  const ui = usePortcoveUi();
  const [sourceIntake, setSourceIntake] = useState<SourceIntakeRequest>();
  const openSourceIntake = useCallback((portId: string, profileId: string, paths: string[] = []) => {
    const port = data.catalog?.ports.find(candidate => candidate.id === portId);
    const profile = data.catalog?.source_profiles?.find(candidate => candidate.id === profileId);
    if (port && profile) setSourceIntake({ portId, portName: port.name, profile, paths });
  }, [data.catalog]);
  const nativeSourceDrag = useNativeSourceDrop(drop => openSourceIntake(drop.portId, drop.profileId, drop.paths));
  const selectedPort = data.catalog?.ports.find(port => port.id === ui.selectedId);
  const inspectionProfiles = ui.view === "settings" ? data.sources.map(source => source.profile_id) : [selectedPort?.source_profile, selectedPort?.bios_source_profile].filter((profile): profile is string => Boolean(profile));
  const sourceHealth = useSourceHealth(operations.perform, data.sources, inspectionProfiles, JSON.stringify(data.catalog?.source_catalog ?? null));
  const appearance = useThemePreference();
  const model = useAppModel(data, ui, operations.setError);
  const installPlanning = useInstallPlanning(model.port?.id, model.status?.channel ?? model.port?.channels[0], operations.perform);
  const backups = usePortBackups(model.port?.id, operations.setError);
  const workspace = useWorkspaceScroll(ui.view);
  const commandSurface = useCommandSurface({ recent: model.recent, installedCount: model.overview.installed, busy: Boolean(operations.busy), setView: ui.setView, setAdoptOpen: ui.setAdoptOpen, setSelectedId: ui.setSelectedId, checkAll: updates.checkAll });
  const handleBack = useCallback(() => {
    const action = overlayBackAction({
      paletteOpen: commandSurface.open,
      adoptionOpen: ui.adoptOpen,
      detailOpen: Boolean(ui.selectedId),
    });
    if (action === "close-palette") commandSurface.setOpen(false);
    else if (action === "close-adoption") ui.setAdoptOpen(false);
    else if (action === "close-detail") ui.setSelectedId(undefined);
    else focusRegion("sidebar");
  }, [commandSurface.open, commandSurface.setOpen, ui.adoptOpen, ui.selectedId, ui.setAdoptOpen, ui.setSelectedId]);
  const controller = useGamepadNavigation(handleBack);
  const hostToolActions: HostToolActions = {
    locate: async (tool: HostToolStatus) => {
      const path = await pickHostToolExecutable(tool.display_name, tool.path ?? "");
      if (!path) return undefined;
      const result = await desktopApi.setHostToolPath(tool.id, path);
      await data.refresh();
      return result;
    },
    clear: async (toolId: string) => { await desktopApi.clearHostToolPath(toolId); await data.refresh(); },
    recheck: async (toolId: string) => desktopApi.recheckHostTool(toolId),
    openOfficial: (toolId: string) => desktopApi.openHostToolOfficialSite(toolId),
  };

  return <div className="app-shell">
    <Sidebar view={ui.view} setView={ui.setView} controller={controller} installedCount={data.statuses.filter(status => status.active).length}
      updateCount={data.statuses.filter(status => currentUpdateSnapshot(status)?.check.update_available).length} onAdopt={() => ui.setAdoptOpen(true)} />
    <main ref={workspace} data-focus-region="workspace">
      <PageHeader view={ui.view} query={ui.query} setQuery={ui.setQuery} portCount={data.catalog?.ports.length ?? 0} onOpenCommands={() => commandSurface.setOpen(true)} />
      <StatusLayer error={operations.error} clearError={() => operations.setError(undefined)} operation={operations.operation} busy={operations.busy} />
      <CurrentView data={data} ui={ui} model={model} operations={operations} github={github} updates={updates} sourceHealth={sourceHealth} appearance={appearance} bootstrap={bootstrap} switchLibrary={switchLibrary} resetLibrary={resetLibrary} nativeSourceDrag={nativeSourceDrag} hostToolActions={hostToolActions} />
    </main>
    <SelectedPortPanel model={model} ui={ui} operations={operations} sourceHealth={sourceHealth} installPlanning={installPlanning} backups={backups} activities={data.activities} libraryGeneration={bootstrap.generation} openSourceIntake={openSourceIntake} />
    <AdoptionOverlay ui={ui} operations={operations} />
    <CommandPalette open={commandSurface.open} commands={commandSurface.commands} close={() => commandSurface.setOpen(false)} />
    {sourceIntake && <SourceIntakeDialog request={sourceIntake} close={() => setSourceIntake(undefined)} onAdded={data.refresh} openEvidence={evidenceId => { void operations.perform("open source evidence", () => desktopApi.openSourceEvidence(evidenceId)); }} hostTools={data.doctor?.host_tools} hostToolActions={hostToolActions} />}
  </div>;
}

type DataState = ReturnType<typeof usePortcoveData>;
type UiState = ReturnType<typeof usePortcoveUi>;
type OperationState = ReturnType<typeof useOperationState>;
type GithubState = ReturnType<typeof useGithubAuth>;
type UpdateState = ReturnType<typeof useUpdateCenter>;
type SourceHealthState = ReturnType<typeof useSourceHealth>;
type AppearanceState = ReturnType<typeof useThemePreference>;
type InstallPlanningState = ReturnType<typeof useInstallPlanning>;
type BackupState = ReturnType<typeof usePortBackups>;

function useAppModel(data: DataState, ui: UiState, setError: (error?: string) => void) {
  useEffect(() => { data.refresh().catch(value => setError(errorText(value))); }, [data.refresh, setError]);
  const statusMap = useMemo(() => indexStatuses(data.statuses), [data.statuses]);
  const registeredSources = useMemo(() => new Set(data.sources.map(source => source.profile_id)), [data.sources]);
  const visible = useMemo(() => filterPorts(data.catalog?.ports ?? [], statusMap, ui.view, ui.filter, ui.query, registeredSources), [data.catalog, statusMap, ui.view, ui.filter, ui.query, registeredSources]);
  const overview = useMemo(() => summarizeLibrary(data.catalog?.ports ?? [], statusMap, registeredSources), [data.catalog, statusMap, registeredSources]);
  const recent = useMemo(() => mostRecentPort(data.catalog?.ports ?? [], statusMap), [data.catalog, statusMap]);
  const sourceNeeds = useMemo(() => requiredSourceNeeds(data.catalog?.ports ?? [], data.catalog?.source_profiles ?? [], statusMap, data.sources), [data.catalog, data.sources, statusMap]);
  const selection = useMemo(() => selectedPort(data, ui.selectedId, statusMap), [data, ui.selectedId, statusMap]);
  useEffect(() => { ui.setSourcePath(selection.source?.path ?? ""); }, [ui.selectedId, selection.source?.path]);
  useEffect(() => { ui.setBiosPath(selection.bios?.path ?? ""); }, [ui.selectedId, selection.bios?.path]);
  return { statusMap, registeredSources, visible, overview, recent, sourceNeeds, ...selection };
}

function selectedPort(data: DataState, selectedId: string | undefined, statuses: ReturnType<typeof indexStatuses>) {
  const port = data.catalog?.ports.find(candidate => candidate.id === selectedId);
  if (!port) return { port: undefined, status: undefined, source: undefined, sourceProfile: undefined, bios: undefined, biosProfile: undefined };
  return {
    port,
    status: statuses.get(port.id),
    source: data.sources.find(source => source.profile_id === port.source_profile),
    sourceProfile: data.catalog?.source_profiles?.find(profile => profile.id === port.source_profile),
    bios: data.sources.find(source => source.profile_id === port.bios_source_profile),
    biosProfile: data.catalog?.source_profiles?.find(profile => profile.id === port.bios_source_profile),
  };
}

function CurrentView({ data, ui, model, operations, github, updates, sourceHealth, appearance, bootstrap, switchLibrary, resetLibrary, nativeSourceDrag, hostToolActions }: {
  data: DataState; ui: UiState; model: ReturnType<typeof useAppModel>; operations: OperationState; github: GithubState; updates: UpdateState; sourceHealth: SourceHealthState; appearance: AppearanceState;
  bootstrap: BootstrapStatus; switchLibrary: (path: string) => Promise<void>; resetLibrary: () => Promise<void>;
  nativeSourceDrag: ReturnType<typeof useNativeSourceDrop>;
  hostToolActions: HostToolActions;
}) {
  if (ui.view === "updates") return <UpdateCenter generation={bootstrap.generation} ports={data.catalog?.ports ?? []} statuses={model.statusMap} activities={data.activities} outcomes={updates.outcomes} busy={operations.busy}
    checkAll={() => { void updates.checkAll(); }} onSelect={ui.setSelectedId} onOpenSources={() => ui.setView("settings")} />;
  if (ui.view === "settings") return <SettingsView doctor={data.doctor} storage={data.storage} github={github} busy={operations.busy} sources={data.sources} appearance={appearance}
    librarySelection={bootstrap.selection ?? undefined} chooseLibrary={pickLibraryFolder} switchLibrary={switchLibrary} resetLibrary={resetLibrary}
    sourceProfiles={data.catalog?.source_profiles ?? []} onSourceAdded={data.refresh} onCatalogChanged={data.refresh}
    hostToolActions={hostToolActions}
    createSupportBundle={() => operations.perform("support bundle", desktopApi.createSupportBundle)}
    exportMetadata={() => operations.perform("export library metadata", async () => {
      const path = await pickMetadataExportPath();
      return path ? desktopApi.exportLibraryMetadata(path) : undefined;
    })}
    sourceOutcomes={sourceHealth.outcomes} sourceInspections={sourceHealth.inspections} verifySources={() => { void sourceHealth.verifyAll(); }} openSourceEvidence={evidenceId => { void operations.perform("open source evidence", () => desktopApi.openSourceEvidence(evidenceId)); }} replaceSource={source => {
      const profile = data.catalog?.source_profiles?.find(candidate => candidate.id === source.profile_id);
      void replaceRegisteredSource(profile, source, operations.perform, operations.setError);
    }} sourceNeeds={model.sourceNeeds} addSource={(profile, archive) => {
      void addRequiredSource(profile, archive, operations.perform, operations.setError);
    }} />;
  return <PortBrowser view={ui.view} ports={model.visible} statuses={model.statusMap} registeredSources={model.registeredSources} overview={model.overview} recent={model.recent}
    filter={ui.filter} setFilter={ui.setFilter} onSelect={ui.setSelectedId} onContinue={portId => { void operations.perform("launch", () => desktopApi.launch(portId, "")); }}
    onBrowseCatalog={() => ui.setView("catalog")} clearFilters={() => { ui.setFilter("all"); ui.setQuery(""); }} loading={!data.catalog} nativeSourceDrag={nativeSourceDrag} />;
}

function SelectedPortPanel({ model, ui, operations, sourceHealth, installPlanning, backups, activities, libraryGeneration, openSourceIntake }: { model: ReturnType<typeof useAppModel>; ui: UiState; operations: OperationState; sourceHealth: SourceHealthState; installPlanning: InstallPlanningState; backups: BackupState; activities: ActivityRecord[]; libraryGeneration: number; openSourceIntake: (portId: string, profileId: string, paths?: string[]) => void }) {
  if (!model.port) return null;
  const pickSource = model.sourceProfile ? () => { void applyPathChoice(pickSourcePath(model.sourceProfile!, ui.sourcePath), ui.setSourcePath, operations.setError); } : undefined;
  const pickArchive = model.sourceProfile?.kind === "file-set" ? () => { void applyPathChoice(pickSourceArchivePath(ui.sourcePath), ui.setSourcePath, operations.setError); } : undefined;
  const pickBios = model.biosProfile ? () => { void applyPathChoice(pickSourcePath(model.biosProfile!, ui.biosPath), ui.setBiosPath, operations.setError); } : undefined;
  return <DetailPanel perform={operations.perform} prepare={(expectedPlan, onEvent) => operations.perform("prepare game data", () => desktopApi.prepare(model.port!.id, expectedPlan, libraryGeneration, onEvent))} port={model.port} status={model.status} installPlan={installPlanning.plan} backups={backups.backups} backupProblems={backups.inventory.problems} backupState={backups.inventory.state} source={model.source} sourceInspection={model.port.source_profile ? sourceHealth.inspections.get(model.port.source_profile) : undefined} sourceProfile={model.sourceProfile} sourcePath={ui.sourcePath} setSourcePath={ui.setSourcePath}
    cancellableActivities={activities.filter(activity => activity.target_id === model.port?.id && activity.cancellation)} libraryGeneration={libraryGeneration} outputLocationChanged={installPlanning.invalidate}
    pickSource={pickSource} pickSourceArchive={pickArchive} busy={operations.busy} bios={model.bios} biosInspection={model.port.bios_source_profile ? sourceHealth.inspections.get(model.port.bios_source_profile) : undefined} biosProfile={model.biosProfile} biosPath={ui.biosPath} setBiosPath={ui.setBiosPath} pickBios={pickBios}
    openSourceEvidence={evidenceId => { void operations.perform("open source evidence", () => desktopApi.openSourceEvidence(evidenceId)); }}
    inspectSource={profile => openSourceIntake(model.port!.id, profile.id)}
    actions={detailActions(model.port, model.status, ui.sourcePath, ui.biosPath, operations.perform, () => ui.setSelectedId(undefined), installPlanning.review, backups.refresh, libraryGeneration)} />;
}

function AdoptionOverlay({ ui, operations }: { ui: UiState; operations: OperationState }) {
  const finish = () => { ui.setAdoptOpen(false); ui.setAdoptPath(""); };
  const planning = useAdoptionPlanning(ui.adoptPath, ui.selectedId, ui.adoptOpen, operations.perform, finish);
  if (!ui.adoptOpen) return null;
  return <AdoptionModal path={ui.adoptPath} setPath={ui.setAdoptPath} preview={planning.preview} busy={operations.busy} close={() => ui.setAdoptOpen(false)}
    pickFolder={() => { void applyPathChoice(pickInstallFolder(ui.adoptPath), ui.setAdoptPath, operations.setError); }}
    review={() => { void planning.review(); }}
    adopt={() => { void planning.adopt(); }} />;
}

async function applyPathChoice(choice: Promise<string | null>, setPath: (path: string) => void, setError: (error?: string) => void) {
  try {
    const path = await choice;
    if (path) setPath(path);
  } catch (value) {
    setError(errorText(value));
  }
}

async function replaceRegisteredSource(profile: SourceProfile | undefined, source: SourceRecord, perform: Perform, setError: (error?: string) => void) {
  if (!profile) {
    setError(`Source profile ${source.profile_id} is not in the current catalog.`);
    return;
  }
  try {
    const path = await pickSourcePath(profile, source.path);
    if (path) await perform("relink source", async () => {
      const plan = await desktopApi.planSourceRelink(profile.id, path);
      return desktopApi.relinkSource(profile.id, path, plan.preview_sha256);
    });
  } catch (value) {
    setError(errorText(value));
  }
}

async function addRequiredSource(profile: SourceProfile, archive: boolean, perform: Perform, setError: (error?: string) => void) {
  try {
    const path = await (archive ? pickSourceArchivePath("") : pickSourcePath(profile, ""));
    if (path) await perform("add source", () => desktopApi.addSource(profile.id, path));
  } catch (value) {
    setError(errorText(value));
  }
}
