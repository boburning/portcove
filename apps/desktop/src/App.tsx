import { useEffect, useMemo } from "react";
import { AdoptionModal } from "./components/AdoptionModal";
import { PageHeader, SettingsView, Sidebar, StatusLayer } from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { DetailPanel } from "./components/DetailPanel";
import { PortBrowser } from "./components/PortBrowser";
import { UpdateCenter } from "./components/UpdateCenter";
import { pickInstallFolder, pickSourceArchivePath, pickSourcePath } from "./file-picker";
import { desktopApi } from "./api";
import { useWorkspaceScroll } from "./keyboard-shortcuts";
import { useThemePreference } from "./theme";
import { useCommandSurface } from "./use-command-surface";
import { adoptInstall, detailActions, type Perform, useGithubAuth, useInstallPlanning, useOperationState, usePortBackups, usePortcoveData, usePortcoveUi, useSourceHealth, useUpdateCenter } from "./use-portcove";
import type { SourceProfile, SourceRecord } from "./types";
import { currentUpdateSnapshot, errorText, filterPorts, indexStatuses, mostRecentPort, requiredSourceNeeds, summarizeLibrary } from "./view-model";

export default function App() {
  const data = usePortcoveData();
  const operations = useOperationState(data.refresh);
  const github = useGithubAuth(operations.perform, operations.setError);
  const updates = useUpdateCenter(operations.perform, data.statuses);
  const sourceHealth = useSourceHealth(operations.perform, data.sources);
  const appearance = useThemePreference();
  const ui = usePortcoveUi();
  const model = useAppModel(data, ui, operations.setError);
  const installPlanning = useInstallPlanning(model.port?.id, model.status?.channel ?? model.port?.channels[0], operations.perform);
  const backups = usePortBackups(model.port?.id, operations.setError);
  const workspace = useWorkspaceScroll(ui.view);
  const commandSurface = useCommandSurface({ recent: model.recent, installedCount: model.overview.installed, busy: Boolean(operations.busy), setView: ui.setView, setAdoptOpen: ui.setAdoptOpen, setSelectedId: ui.setSelectedId, checkAll: updates.checkAll });

  return <div className="app-shell">
    <Sidebar view={ui.view} setView={ui.setView} installedCount={data.statuses.filter(status => status.active).length}
      updateCount={data.statuses.filter(status => currentUpdateSnapshot(status)?.check.update_available).length} onAdopt={() => ui.setAdoptOpen(true)} />
    <main ref={workspace}>
      <PageHeader view={ui.view} query={ui.query} setQuery={ui.setQuery} portCount={data.catalog?.ports.length ?? 0} onOpenCommands={() => commandSurface.setOpen(true)} />
      <StatusLayer error={operations.error} clearError={() => operations.setError(undefined)} operation={operations.operation} busy={operations.busy} />
      <CurrentView data={data} ui={ui} model={model} operations={operations} github={github} updates={updates} sourceHealth={sourceHealth} appearance={appearance} />
    </main>
    <SelectedPortPanel model={model} ui={ui} operations={operations} installPlanning={installPlanning} backups={backups} />
    <AdoptionOverlay ui={ui} operations={operations} />
    <CommandPalette open={commandSurface.open} commands={commandSurface.commands} close={() => commandSurface.setOpen(false)} />
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
    sourceProfile: data.catalog?.source_profiles.find(profile => profile.id === port.source_profile),
    bios: data.sources.find(source => source.profile_id === port.bios_source_profile),
    biosProfile: data.catalog?.source_profiles.find(profile => profile.id === port.bios_source_profile),
  };
}

function CurrentView({ data, ui, model, operations, github, updates, sourceHealth, appearance }: {
  data: DataState; ui: UiState; model: ReturnType<typeof useAppModel>; operations: OperationState; github: GithubState; updates: UpdateState; sourceHealth: SourceHealthState; appearance: AppearanceState;
}) {
  if (ui.view === "updates") return <UpdateCenter ports={data.catalog?.ports ?? []} statuses={model.statusMap} activities={data.activities} outcomes={updates.outcomes} actions={updates.actions} busy={operations.busy}
    checkAll={() => { void updates.checkAll(); }} applyPolicies={() => { void updates.applyPolicies(); }} onSelect={ui.setSelectedId} onOpenSources={() => ui.setView("settings")} />;
  if (ui.view === "settings") return <SettingsView storage={data.storage} github={github} busy={operations.busy} sources={data.sources} appearance={appearance}
    sourceOutcomes={sourceHealth.outcomes} verifySources={() => { void sourceHealth.verifyAll(); }} replaceSource={source => {
      const profile = data.catalog?.source_profiles.find(candidate => candidate.id === source.profile_id);
      void replaceRegisteredSource(profile, source, operations.perform, operations.setError);
    }} sourceNeeds={model.sourceNeeds} addSource={(profile, archive) => {
      void addRequiredSource(profile, archive, operations.perform, operations.setError);
    }} />;
  return <PortBrowser view={ui.view} ports={model.visible} statuses={model.statusMap} registeredSources={model.registeredSources} overview={model.overview} recent={model.recent}
    filter={ui.filter} setFilter={ui.setFilter} onSelect={ui.setSelectedId} onContinue={portId => { void operations.perform("launch", () => desktopApi.launch(portId, "")); }}
    onBrowseCatalog={() => ui.setView("catalog")} clearFilters={() => { ui.setFilter("all"); ui.setQuery(""); }} loading={!data.catalog} />;
}

function SelectedPortPanel({ model, ui, operations, installPlanning, backups }: { model: ReturnType<typeof useAppModel>; ui: UiState; operations: OperationState; installPlanning: InstallPlanningState; backups: BackupState }) {
  if (!model.port) return null;
  const pickSource = model.sourceProfile ? () => { void applyPathChoice(pickSourcePath(model.sourceProfile!, ui.sourcePath), ui.setSourcePath, operations.setError); } : undefined;
  const pickArchive = model.sourceProfile?.kind === "file-set" ? () => { void applyPathChoice(pickSourceArchivePath(ui.sourcePath), ui.setSourcePath, operations.setError); } : undefined;
  const pickBios = model.biosProfile ? () => { void applyPathChoice(pickSourcePath(model.biosProfile!, ui.biosPath), ui.setBiosPath, operations.setError); } : undefined;
  return <DetailPanel port={model.port} status={model.status} installPlan={installPlanning.plan} backups={backups.backups} source={model.source} sourceProfile={model.sourceProfile} sourcePath={ui.sourcePath} setSourcePath={ui.setSourcePath}
    pickSource={pickSource} pickSourceArchive={pickArchive} busy={operations.busy} bios={model.bios} biosProfile={model.biosProfile} biosPath={ui.biosPath} setBiosPath={ui.setBiosPath} pickBios={pickBios}
    actions={detailActions(model.port, model.status, ui.sourcePath, ui.biosPath, operations.perform, () => ui.setSelectedId(undefined), installPlanning.review, backups.refresh)} />;
}

function AdoptionOverlay({ ui, operations }: { ui: UiState; operations: OperationState }) {
  if (!ui.adoptOpen) return null;
  const finish = () => { ui.setAdoptOpen(false); ui.setAdoptPath(""); };
  return <AdoptionModal path={ui.adoptPath} setPath={ui.setAdoptPath} busy={operations.busy} close={() => ui.setAdoptOpen(false)}
    pickFolder={() => { void applyPathChoice(pickInstallFolder(ui.adoptPath), ui.setAdoptPath, operations.setError); }}
    adopt={() => { void adoptInstall(ui.adoptPath, ui.selectedId, operations.perform, finish); }} />;
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
    if (path) await perform("replace source", () => desktopApi.addSource(profile.id, path));
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
