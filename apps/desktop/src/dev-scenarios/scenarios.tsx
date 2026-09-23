import { renderToStaticMarkup } from "react-dom/server";
import { DetailPanel, InstallAction, type DetailActions } from "../components/DetailPanel";
import { PortBrowser } from "../components/PortBrowser";
import { BackupHistory } from "../components/BackupHistory";
import { HostToolRow, StatusLayer } from "../components/Chrome";
import { WorkspaceRefreshNotice } from "../features/workspace/WorkspaceRefreshNotice";
import { failureReport, portDefinition, portStatus, sourceProfile } from "../test-fixtures";
import type {
  DesktopError,
  InstallPlan,
  InstallRecord,
  PortDefinition,
  PortStatus,
} from "../types";

export const scenarios = [
  {
    id: "empty-library",
    label: "Empty library",
    theme: "dark",
    viewport: "wide",
    limitation: "No catalog discovery or library IPC is executed.",
  },
  {
    id: "filtered-empty-library",
    label: "Filtered empty library",
    theme: "light",
    viewport: "wide",
    limitation:
      "Installed content is supplied but filtered out; search and filter state do not run.",
  },
  {
    id: "unavailable-library",
    label: "Unavailable library",
    theme: "dark",
    viewport: "narrow",
    limitation: "The initial-load failure is synthetic; retry and library IPC do not run.",
  },
  {
    id: "partial-success",
    label: "Partial success",
    theme: "light",
    viewport: "wide",
    limitation:
      "The committed mutation and failed refresh are supplied facts; no files are changed.",
  },
  {
    id: "cancelled-operation",
    label: "Cancelled operation",
    theme: "dark",
    viewport: "narrow",
    limitation: "The neutral cancellation outcome is supplied; no native prompt or operation runs.",
  },
  {
    id: "ready-game",
    label: "Ready game",
    theme: "dark",
    viewport: "wide",
    limitation: "Readiness is a supplied typed fixture, not a launch or eligibility check.",
  },
  {
    id: "missing-source",
    label: "Missing source",
    theme: "dark",
    viewport: "wide",
    limitation: "No file picker, source inspection or source acquisition runs.",
  },
  {
    id: "missing-tool",
    label: "Missing tool",
    theme: "dark",
    viewport: "wide",
    limitation: "The supplied missing-tool status does not probe or install a host tool.",
  },
  {
    id: "staged-update",
    label: "Staged update",
    theme: "dark",
    viewport: "wide",
    limitation: "No update, activation, download or signature verification runs.",
  },
  {
    id: "interrupted-operation",
    label: "Interrupted operation",
    theme: "dark",
    viewport: "wide",
    limitation:
      "This previews backup recovery text; it does not reproduce a crash or recover data.",
  },
  {
    id: "refresh-failure",
    label: "Refresh failure",
    theme: "dark",
    viewport: "wide",
    limitation: "The retained-snapshot error is synthetic; retry and subscriptions do not run.",
  },
  {
    id: "unavailable-provider",
    label: "Unavailable artwork/provider",
    theme: "dark",
    viewport: "wide",
    limitation: "Only failure presentation is shown; no provider request or image decoding runs.",
  },
  {
    id: "library-reference-long-title",
    label: "Library reference · long title",
    theme: "light",
    viewport: "wide",
    limitation:
      "The installed library and missing artwork are supplied fixtures; refresh and image decoding do not run.",
  },
  {
    id: "game-details-reference-narrow",
    label: "Game details reference · narrow",
    theme: "dark",
    viewport: "narrow",
    limitation:
      "The selected game and narrow viewport are supplied; dialog focus, navigation and native artwork do not run.",
  },
  {
    id: "installation-review-reference",
    label: "Installation review reference",
    theme: "light",
    viewport: "narrow",
    limitation:
      "The reviewed plan is a typed fixture; source validation, trust checks, download and installation do not run.",
  },
] as const;

type ScenarioId = (typeof scenarios)[number]["id"];

export function blockedScenarioAction(): never {
  throw new Error("Development scenario actions are disabled");
}

const actions: DetailActions = {
  activate: blockedScenarioAction,
  backup: blockedScenarioAction,
  check: blockedScenarioAction,
  close: blockedScenarioAction,
  deleteBackup: blockedScenarioAction,
  dismissInstallReview: blockedScenarioAction,
  install: blockedScenarioAction,
  launch: blockedScenarioAction,
  openUserData: blockedScenarioAction,
  reviewInstall: blockedScenarioAction,
  restoreBackup: blockedScenarioAction,
  rollback: blockedScenarioAction,
  remove: blockedScenarioAction,
  setChannel: blockedScenarioAction,
  setPolicy: blockedScenarioAction,
  verify: blockedScenarioAction,
};

function installed(portId = "sample"): InstallRecord {
  return {
    id: "scenario-install-1",
    port_id: portId,
    version: "1.0",
    path: "sample/1.0",
    channel: "stable",
    installed_at: 1,
    verified: true,
    staged: false,
    artifact: { asset_name: "sample.zip", sha256: "b".repeat(64), size: 1 },
    manifest_sha256: "c".repeat(64),
    selected_executable: "sample.exe",
    runtime: null,
  };
}

function reviewedInstallPlan(port: PortDefinition): InstallPlan {
  return {
    bundled_runtime: null,
    port_id: port.id,
    channel: "stable",
    platform: "windows-x86-64",
    action: "download",
    source_requirements: [],
    download_bytes: 64 * 1024 ** 2,
    release: {
      published_at: "2026-09-20T00:00:00Z",
      version: "2.0",
      channel: "stable",
      asset: {
        name: "scenario-game-windows.zip",
        url: "https://example.com/scenario-game-windows.zip",
        size: 64 * 1024 ** 2,
        sha256: "d".repeat(64),
      },
    },
    storage: {
      library_root: "E:/Portcove",
      volume_total_bytes: 1024 ** 4,
      volume_available_bytes: 512 * 1024 ** 3,
    },
    output_location: {
      configured_output_directory: null,
      port_id: port.id,
      library_root: "E:/Portcove",
      default_output_directory: `E:/Portcove/versions/${port.id}`,
      effective_output_directory: `E:/Portcove/versions/${port.id}`,
      selection_source: "library_default",
      user_data_root: `E:/Portcove/user/${port.id}`,
    },
  };
}

function scenarioError({
  scenarioId,
  code,
  message,
  summary,
  technicalMessage,
  tone = "error",
  mutationState = "unknown",
  recoveryActions = ["view_technical_details"],
}: {
  scenarioId: string;
  code: DesktopError["code"];
  message: string;
  summary: string;
  technicalMessage: string;
  tone?: DesktopError["presentation"]["tone"];
  mutationState?: DesktopError["presentation"]["mutation_state"];
  recoveryActions?: DesktopError["presentation"]["recovery_actions"];
}): DesktopError {
  return {
    code,
    message,
    details: {},
    presentation: {
      presentation_key: "development_scenario",
      summary,
      tone,
      mutation_state: mutationState,
      phase: null,
      recovery_actions: recoveryActions,
      technical_message: technicalMessage,
      technical_context: { scenario: scenarioId },
    },
  };
}

function ReferenceWorkspace({ mode }: { mode: "library" | "details" | "installation-review" }) {
  const port = {
    ...portDefinition(),
    name: "The Unreasonably Long Scenario Game Title: Definitive Portable Edition",
    summary:
      "A deterministic long-title reference with generated artwork fallback and retained player-facing metadata.",
  };
  const secondPort = {
    ...portDefinition(),
    id: "second-scenario",
    name: "Compact companion game",
  };
  const installedStatus: PortStatus = {
    ...portStatus(),
    port_id: port.id,
    active: installed(port.id),
    readiness: { launchable: true, blockers: [], pending_setup: false },
  };
  const secondStatus: PortStatus = {
    ...portStatus(),
    port_id: secondPort.id,
    active: installed(secondPort.id),
    readiness: { launchable: true, blockers: [], pending_setup: false },
  };
  const reviewing = mode === "installation-review";
  const detailStatus: PortStatus = reviewing
    ? {
        ...portStatus(),
        port_id: port.id,
      }
    : installedStatus;
  return (
    <div className="scenario-workspace-reference">
      {mode === "library" ? (
        <PortBrowser
          view="library"
          ports={[port, secondPort]}
          statuses={
            new Map([
              [port.id, installedStatus],
              [secondPort.id, secondStatus],
            ])
          }
          overview={{ installed: 2, ready: 2, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={blockedScenarioAction}
          onSelect={blockedScenarioAction}
          loading={false}
        />
      ) : (
        <DetailPanel
          port={port}
          status={detailStatus}
          sourcePath=""
          setSourcePath={blockedScenarioAction}
          actions={actions}
        />
      )}
      {reviewing && (
        <InstallAction
          ready
          sourceReady
          biosReady
          plan={reviewedInstallPlan(port)}
          install={blockedScenarioAction}
          review={blockedScenarioAction}
          dismiss={blockedScenarioAction}
          portaled={false}
        />
      )}
    </div>
  );
}

function Scenario({ id }: { id: ScenarioId }) {
  if (id === "library-reference-long-title") return <ReferenceWorkspace mode="library" />;
  if (id === "game-details-reference-narrow") return <ReferenceWorkspace mode="details" />;
  if (id === "installation-review-reference")
    return <ReferenceWorkspace mode="installation-review" />;
  const port = { ...portDefinition(), name: "Scenario game" };
  if (id === "empty-library")
    return (
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={blockedScenarioAction}
        onSelect={blockedScenarioAction}
        loading={false}
      />
    );
  if (id === "filtered-empty-library")
    return (
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={{ installed: 2, ready: 1, needsSetup: 1, staged: 0 }}
        filter="ready"
        setFilter={blockedScenarioAction}
        onSelect={blockedScenarioAction}
        clearFilters={blockedScenarioAction}
        loading={false}
      />
    );
  if (id === "unavailable-library")
    return (
      <WorkspaceRefreshNotice
        hasSnapshot={false}
        refreshing={false}
        failure={{
          error: scenarioError({
            scenarioId: "unavailable-library",
            code: "state",
            message: "Scenario library is unavailable.",
            summary: "The scenario library could not be loaded.",
            technicalMessage: "Initial scenario library load failed.",
            recoveryActions: ["view_technical_details"],
          }),
        }}
        retry={blockedScenarioAction}
        retryRecovery={blockedScenarioAction}
      />
    );
  if (id === "partial-success") {
    return (
      <StatusLayer
        clearError={blockedScenarioAction}
        error={scenarioError({
          scenarioId: "partial-success",
          code: "state",
          message: "The change was saved, but current library information could not be refreshed.",
          summary: "The change was saved, but Portcove could not refresh the current view.",
          technicalMessage: "Scenario refresh failed after the change was committed.",
          mutationState: "committed",
          recoveryActions: ["review_current_state", "view_technical_details"],
        })}
      />
    );
  }
  if (id === "cancelled-operation") {
    return (
      <StatusLayer
        clearError={blockedScenarioAction}
        error={scenarioError({
          scenarioId: "cancelled-operation",
          code: "cancelled",
          message: "Scenario operation cancelled.",
          summary: "The operation was cancelled before it changed any files.",
          technicalMessage: "Scenario operation cancelled before mutation.",
          tone: "neutral",
          mutationState: "no_changes",
          recoveryActions: [],
        })}
      />
    );
  }
  if (id === "missing-tool")
    return (
      <HostToolRow
        busy={false}
        tool={{
          id: "chdman",
          display_name: "chdman",
          state: "missing",
          path: null,
          source: null,
          configuration_variable: "PORTCOVE_CHDMAN",
          purpose: "CHD validation and disc-image materialization",
          official_url: "https://docs.mamedev.org/tools/chdman.html",
        }}
      />
    );
  if (id === "interrupted-operation")
    return (
      <BackupHistory
        backups={[]}
        state="recovery_required"
        problems={[
          {
            kind: "recovery_required",
            backup_id: null,
            operation_id: "scenario-operation",
            path: "backups/sample/.deleting-scenario",
            message: "Deletion was interrupted.",
            proposed_action: "Restart Portcove, then review doctor output.",
          },
        ]}
        restore={blockedScenarioAction}
        remove={blockedScenarioAction}
      />
    );
  if (id === "refresh-failure")
    return (
      <WorkspaceRefreshNotice
        hasSnapshot
        refreshing={false}
        failure={{ error: { ...failureReport(), message: "Scenario refresh is unavailable." } }}
        retry={blockedScenarioAction}
        retryRecovery={blockedScenarioAction}
      />
    );
  if (id === "unavailable-provider")
    return (
      <StatusLayer
        clearError={blockedScenarioAction}
        error={{
          ...failureReport(),
          code: "artwork_unavailable",
          message: "Scenario artwork provider is unavailable.",
          presentation: {
            ...failureReport().presentation,
            summary: "Artwork is unavailable. Your existing choice is retained.",
          },
        }}
      />
    );
  const status: PortStatus = {
    ...portStatus(),
    active: installed(),
    readiness: { launchable: true, blockers: [], pending_setup: false },
  };
  if (id === "missing-source") {
    port.source_profile = "sample";
    status.active = null;
    status.readiness = { launchable: false, blockers: ["missing_source"], pending_setup: true };
  }
  if (id === "staged-update")
    status.staged = { ...installed(), id: "scenario-install-2", version: "2.0", staged: true };
  return (
    <DetailPanel
      port={port}
      status={status}
      sourcePath=""
      setSourcePath={blockedScenarioAction}
      sourceProfile={id === "missing-source" ? sourceProfile() : undefined}
      actions={actions}
    />
  );
}

export function renderScenario(id: string): string {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown development scenario: ${id}`);
  // Static rendering intentionally does not mount effects or retain event handlers.
  return renderToStaticMarkup(
    <section
      data-development-scenario={scenario.id}
      data-scenario-viewport={scenario.viewport}
      data-theme={scenario.theme}
      inert
    >
      <Scenario id={scenario.id} />
    </section>,
  );
}
