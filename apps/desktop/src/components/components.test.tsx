import { failureReport, portDefinition, portStatus, sourceProfile } from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ActivityRecord,
  InstallRecord,
  OperationEvent,
  PortDefinition,
  PortStatus,
  SourceInspectionReport,
  UpdateCheckOutcome,
} from "../types";
import { PageHeader, SettingsView, Sidebar, StatusLayer } from "./Chrome";
import { BackupHistory } from "./BackupHistory";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { PortBrowser } from "./PortBrowser";
import { UpdateCenter } from "./UpdateCenter";
import { RecoveryReview } from "./RecoveryReview";
import { applyOperationEvent, mostRecentOperation } from "../features/operations/operation-state";
import { OperationCancellation } from "./OperationCancellation";
import embeddedCatalog from "../../../../crates/portcove-core/catalog/catalog.json";

function currentCatalogPort(id: string): PortDefinition {
  const serialized = embeddedCatalog.ports.find((candidate) => candidate.id === id);
  if (!serialized) throw new Error(`Missing embedded catalog port ${id}`);
  return { ...portDefinition(), ...serialized } as unknown as PortDefinition;
}

const port: PortDefinition = {
  ...portDefinition(),
  id: "sample",
  name: "Sample Port",
  summary: "A sample native port",
  project_url: "https://example.com",
  support_tier: "stable",
  channels: ["stable", "beta"],
  platforms: ["windows-x86-64"],
  adapter: "staged-source-portable",
  automated_tested_platforms: ["windows-x86-64"],
  manually_validated_platforms: [],
  source_profile: "sample-rom",
  persistent_paths: ["save"],
  upstream_status: "active",
  presentation: {
    installation_method: "staged-game-files",
    source_requirements: [
      {
        role: "game",
        profile_id: "sample-rom",
        label: "Sample cartridge",
        verification: "catalog-identity",
      },
    ],
    saves_and_settings: "portcove-managed",
  },
  release: portDefinition().release,
  executable_hints: {},
};
const biosPort = currentCatalogPort("mortal-kombat-4-recompiled");
const psxBiosProfile = {
  ...sourceProfile(),
  id: "psx-scph-1001-bios",
  label: "PlayStation SCPH-1001 BIOS",
  accepted_extensions: ["bin", "rom"],
  accepted_sha1: ["10155d8d6e6e832d6ea66db9bc098321fb5e8ebf"],
  accepted_sha256: ["71af94d1e47a68c11e8fdb9f8368040601514a42a5a399cda48c7d3bff1e99d3"],
};
const mortalKombat4Profile = {
  ...sourceProfile(),
  id: "mortal-kombat-4-psx",
  label: "Mortal Kombat 4 (USA) disc",
  kind: "psx-disc" as const,
  accepted_extensions: ["chd"],
  accepted_sha1: ["21515cdd9829521a2db76a83300b77e83855fa88"],
  accepted_sha256: ["c43311155c03f7f9c23e7228bbf8874a5fdaa0984dbbefa356e5899eb40038a3"],
  disc: { track_counts: [23], discs: [] },
};
const mortalKombat4Source = {
  profile_id: mortalKombat4Profile.id,
  path: "game.chd",
  sha256: mortalKombat4Profile.accepted_sha256[0],
  size: 1,
  storage_sha256: mortalKombat4Profile.accepted_sha256[0],
  storage_size: 1,
  updated_at: 1,
};
const actions: DetailActions = {
  activate: vi.fn(),
  backup: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
  deleteBackup: vi.fn(),
  dismissInstallReview: vi.fn(),
  install: vi.fn(),
  launch: vi.fn(),
  openUserData: vi.fn(),
  reviewInstall: vi.fn(),
  remove: vi.fn(),
  restoreBackup: vi.fn(),
  rollback: vi.fn(),
  setChannel: vi.fn(),
  setPolicy: vi.fn(),
  verify: vi.fn(),
};

describe("operation cancellation", () => {
  it("uses operation-neutral waiting copy and distinguishes finishing", () => {
    const requested = renderToStaticMarkup(
      <OperationCancellation
        operationId="00000000-0000-0000-0000-000000000001"
        state={{ phase: "preparing", requested: true }}
      />,
    );
    expect(requested).toContain("Cancellation requested");
    expect(requested).toContain(
      "Portcove will stop after the current step reaches a safe stopping point.",
    );
    expect(requested).not.toContain("Waiting for the current safe step to stop.");
    expect(requested).not.toContain("preparation step");

    const finishing = renderToStaticMarkup(
      <OperationCancellation
        operationId="00000000-0000-0000-0000-000000000001"
        state={{ phase: "finishing", requested: false }}
      />,
    );
    expect(finishing).toContain("Finishing safely…");
    expect(finishing).not.toContain("Cancel operation");
  });
});
const installRecord = (overrides: Partial<InstallRecord> = {}): InstallRecord => ({
  id: "1",
  port_id: port.id,
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
  ...overrides,
});

const bundledRuntime = {
  archive_root: "runtime",
  asset: {
    name: "runtime.zip",
    url: "https://example.com/runtime.zip",
    size: 1024,
    sha256: "d".repeat(64),
  },
  executable: "runtime.exe",
  target_directory: "runtime",
} satisfies NonNullable<PortDefinition["bundled_runtime"]["windows-x86-64"]>;

const runtimeIdentity = {
  archive_root: bundledRuntime.archive_root,
  artifact: {
    asset_name: bundledRuntime.asset.name,
    sha256: bundledRuntime.asset.sha256,
    size: bundledRuntime.asset.size,
  },
  executable: bundledRuntime.executable,
  origin: "verified_download",
  target_directory: bundledRuntime.target_directory,
} satisfies NonNullable<InstallRecord["runtime"]>;

const missingRuntimeFixture = (updateAvailable: boolean) => {
  const active = installRecord({ runtime: runtimeIdentity });
  const requiredBundledRuntime = updateAvailable
    ? {
        ...bundledRuntime,
        asset: {
          ...bundledRuntime.asset,
          name: "runtime-2.zip",
          sha256: "e".repeat(64),
        },
        executable: "runtime-2.exe",
      }
    : bundledRuntime;
  const requiredRuntime = {
    archive_root: requiredBundledRuntime.archive_root,
    artifact: {
      asset_name: requiredBundledRuntime.asset.name,
      sha256: requiredBundledRuntime.asset.sha256,
      size: requiredBundledRuntime.asset.size,
    },
    executable: requiredBundledRuntime.executable,
    origin: "verified_download" as const,
    target_directory: requiredBundledRuntime.target_directory,
  };
  return {
    bundledRuntime: requiredBundledRuntime,
    status: {
      ...portStatus(),
      active,
      readiness: {
        launchable: false,
        blockers: ["missing_runtime"],
        pending_setup: false,
      },
      last_update_check: {
        checked_at: 2,
        check: {
          port_id: port.id,
          channel: active.channel,
          installed_version: active.version,
          installed_artifact: active.artifact,
          installed_runtime: active.runtime,
          required_runtime: requiredRuntime,
          update_available: updateAvailable,
          release: {
            published_at: null,
            version: active.version,
            channel: active.channel,
            asset: {
              name: active.artifact.asset_name,
              url: "https://example.com/sample.zip",
              size: active.artifact.size,
              sha256: active.artifact.sha256,
            },
          },
        },
      },
    } satisfies PortStatus,
  };
};

describe("desktop components", () => {
  it.each(["future_state", "constructor", "__proto__"])(
    "keeps unknown activity and policy labels neutral for %s",
    (value) => {
      const status = {
        ...portStatus(),
        active: installRecord(),
        channel: value as PortStatus["channel"],
        update_policy: value as PortStatus["update_policy"],
      };
      const html = renderToStaticMarkup(
        <UpdateCenter
          generation={1}
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          activities={[
            {
              id: "unknown",
              operation: value as import("../types").ActivityOperation,
              target_kind: "port",
              target_id: port.id,
              status: "succeeded",
              started_at: 1,
              finished_at: 2,
              failure: null,
              cancellation: null,
              message: null,
            },
          ]}
          outcomes={[]}
          diagnosticsRefreshing={false}
          diagnosticsStale={false}
          refreshDiagnostics={vi.fn()}
          checkAll={vi.fn()}
          onSelect={vi.fn()}
          onOpenSources={vi.fn()}
        />,
      );
      expect(html).toContain("Recorded activity");
      expect(html).toContain("Unknown channel");
      expect(html).toContain("Update policy unavailable");
      expect(html).not.toContain("· Notify");
    },
  );

  it("shows ongoing parent progress after a child finishes while retaining failure notice", () => {
    const parent: OperationEvent = {
      schema_version: 2,
      parent_operation_id: null,
      target: null,
      operation_id: "parent",
      sequence: 2,
      timestamp_ms: 1,
      operation: "install",
      type: "progress",
      phase: "download",
      completed: 1,
      total: 2,
    };
    const child: OperationEvent = {
      schema_version: 2,
      target: null,
      operation_id: "child",
      parent_operation_id: "parent",
      sequence: 3,
      timestamp_ms: 2,
      operation: "verify",
      type: "finished",
      result: "failed",
    };
    const state = applyOperationEvent(applyOperationEvent(new Map(), parent), child);
    const html = renderToStaticMarkup(
      <StatusLayer
        error="Child verification failed"
        clearError={vi.fn()}
        operation={mostRecentOperation(state)}
        busy="install"
      />,
    );
    expect(html).toContain("width:50%");
    expect(html).toContain("Child verification failed");
  });

  it("labels a new non-streaming task without reusing completed update progress", () => {
    const finished: OperationEvent = {
      schema_version: 2,
      parent_operation_id: null,
      target: null,
      operation_id: "old-update",
      sequence: 4,
      timestamp_ms: 1,
      operation: "update",
      type: "finished",
      result: "succeeded",
    };
    for (const operation of [undefined, finished]) {
      const html = renderToStaticMarkup(
        <StatusLayer clearError={vi.fn()} operation={operation} busy="backup" />,
      );
      expect(html).toContain("Backup in progress");
      expect(html).toContain("Progress total not yet known.");
      expect(html).not.toContain("Old update");
      expect(html).not.toContain("width:100%");
    }
  });

  it.each(["future-method", "constructor", "__proto__"])(
    "renders unknown installation method %s without assuming support",
    (method) => {
      const html = renderToStaticMarkup(
        <DetailPanel
          port={{
            ...port,
            presentation: {
              ...port.presentation!,
              installation_method: method as NonNullable<
                PortDefinition["presentation"]
              >["installation_method"],
            },
            source_profile: null,
          }}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
        />,
      );
      expect(html).toContain("Unavailable in this catalog");
      expect(html).not.toContain("[object Object]");
    },
  );

  it("renders game details as a workspace destination instead of a modal", () => {
    const html = renderToStaticMarkup(
      <DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(html).toContain("data-detail-workspace");
    expect(html).toContain('aria-label="Back to previous workspace"');
    expect(html).toContain(`<h1 class="detail-title" id="port-detail-title">${port.name}</h1>`);
    expect(html).not.toContain('<h2 id="port-detail-title">');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain('class="scrim"');
  });

  it("labels presentation omitted by an older catalog", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, presentation: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(html).toContain("Structured requirement details are unavailable in this catalog.");
    expect(html).toContain("Installation method</small>Unavailable in this catalog");
    expect(html).toContain("Saved data handling</small>Unavailable in this catalog");
  });

  it("routes a missing required component to the available update instead of Play", () => {
    const fixture = missingRuntimeFixture(true);
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          bundled_runtime: { "windows-x86-64": fixture.bundledRuntime },
          source_profile: null,
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={fixture.status}
      />,
    );
    expect(html).toContain("Update required before playing");
    expect(html).toContain("Install the available update that includes the required component");
    expect(html).toContain("Review game update");
    expect(html).not.toContain("Verified runtime required");
    expect(html).not.toContain("Play now");
    expect(html).not.toContain("Choose required source");
  });

  it("does not promise an update when a recorded required component needs repair", () => {
    const fixture = missingRuntimeFixture(false);
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          bundled_runtime: { "windows-x86-64": fixture.bundledRuntime },
          source_profile: null,
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={fixture.status}
      />,
    );
    expect(html).toContain("Required component unavailable");
    expect(html).toContain(
      "Check for updates. If none is available, verify the installation for diagnostic details.",
    );
    expect(html).not.toContain("Update required before playing");
    expect(html).not.toContain("Install the available update");
    expect(html).not.toContain("Play now");
  });

  it("names managed first-run preparation as required game files", () => {
    const profileId = "opengoal-jak1-disc";
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          adapter: "upstream-managed-setup",
          executable_hints: { "windows-x86-64": ["gk.exe"] },
          launch_arguments: ["--game", "jak1", "--portable"],
          presentation: {
            installation_method: "upstream-setup",
            source_requirements: [
              {
                role: "game",
                profile_id: profileId,
                label: "Jak and Daxter retail disc",
                verification: "upstream-validator",
              },
            ],
            saves_and_settings: "portcove-managed",
          },
          runtime_source_filename: "source.iso",
          runtime_source_materialization: "ps2-iso",
          setup_arguments: ["--game", "jak1", "--extract", "--validate"],
          setup_executable_hints: { "windows-x86-64": ["extractor.exe"] },
          setup_marker: "data/out/jak1/iso/0COMMON.TXT",
          setup_output_paths: ["data/iso_data", "data/decompiler_out", "data/out"],
          source_profile: profileId,
        }}
        source={{
          profile_id: profileId,
          path: "source.iso",
          sha256: "a".repeat(64),
          size: 1024,
          storage_sha256: "a".repeat(64),
          storage_size: 1024,
          updated_at: 1,
        }}
        sourcePath="source.iso"
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          active: installRecord(),
          readiness: {
            launchable: false,
            blockers: ["preparation_required"],
            pending_setup: true,
            source: "current",
          },
        }}
      />,
    );
    expect(html).toContain("First-time setup required");
    expect(html).toContain("Complete the port&#x27;s setup before playing.");
    expect(html).not.toContain("Game files required");
    expect(html).not.toContain("Prepare game data</strong>");
    expect(html).not.toContain("Portcove will run and verify the upstream setup before play.");
  });

  it("uses player-facing ready and downloaded-update labels", () => {
    const status: PortStatus = {
      ...portStatus(),
      active: installRecord(),
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
      },
    };
    const ready = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={status}
      />,
    );
    const downloaded = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{ ...status, staged: { ...installRecord(), id: "2", staged: true } }}
      />,
    );

    expect(ready).toContain("Ready to play");
    expect(ready).toContain("The installed version and all required game files are available.");
    expect(downloaded).toContain("Ready to play · update downloaded");
    expect(downloaded).toContain("Play the installed version or review the downloaded update.");
    expect(`${ready}${downloaded}`).not.toContain("Ready to launch");
    expect(`${ready}${downloaded}`).not.toContain("update staged");
    expect(`${ready}${downloaded}`).not.toContain("active version");
  });

  it("shows installation repair without asking for a different source", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          active: installRecord(),
          readiness: {
            launchable: false,
            blockers: ["invalid_installation"],
            pending_setup: false,
          },
        }}
      />,
    );
    expect(html).toContain("Installation needs repair");
    expect(html).toContain("Portcove couldn&#x27;t verify the installed files.");
    expect(html.match(/>Verify installation<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(
      /<div class="actions primary-actions"><button[^>]*>.*Verify installation<\/button><\/div>/s,
    );
    expect(html).not.toContain("Play now");
    expect(html).not.toContain("Choose required source");
    expect(html).not.toContain("Verify the game files below");

    const checking = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        busy="verify"
        status={{
          ...portStatus(),
          active: installRecord(),
          readiness: {
            launchable: false,
            blockers: ["invalid_installation"],
            pending_setup: false,
          },
        }}
      />,
    );
    expect(checking.match(/<div class="actions primary-actions"><button([^>]*)>/)?.[1]).toContain(
      "disabled",
    );
  });

  it.each([
    ["current", "Files are unchanged since they were added"],
    ["not_checked", "Files added · current contents not checked"],
    ["changed", "Files have changed since they were added"],
    ["missing", "Files not found at the saved location"],
    ["unreadable", "Portcove couldn't read these files"],
    ["not_baselined", "No saved record to compare these files with"],
  ] as const)("describes game-file health %s with the hash in File details", (health, note) => {
    const source = {
      profile_id: "sample-rom",
      path: "source.z64",
      sha256: "a".repeat(64),
      size: 12,
      storage_sha256: "a".repeat(64),
      storage_size: 12,
      updated_at: 1,
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        source={source}
        sourcePath={source.path}
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          active: installRecord(),
          readiness: {
            launchable: health === "current",
            blockers: [],
            pending_setup: false,
            source: health,
          },
        }}
      />,
    );
    expect(html).toContain(note.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Registered game files");
    expect(html).toMatch(
      /<details class="source-technical"><summary[^>]*>File details<\/summary>/u,
    );
    expect(html).toContain(`Saved SHA-256</strong><code>${source.sha256}</code>`);
  });

  it.each([
    ["current", "BIOS file is unchanged since it was added"],
    ["not_checked", "BIOS file added · current contents not checked"],
    ["changed", "BIOS file has changed since it was added"],
    ["missing", "BIOS file not found at the saved location"],
    ["unreadable", "Portcove couldn't read this BIOS file"],
    ["not_baselined", "No saved record to compare this BIOS file with"],
  ] as const)("uses BIOS-specific grammar for health %s", (health, note) => {
    const bios = {
      profile_id: psxBiosProfile.id,
      path: "scph1001.bin",
      sha256: "b".repeat(64),
      size: 524_288,
      storage_sha256: "b".repeat(64),
      storage_size: 524_288,
      updated_at: 1,
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={biosPort}
        source={mortalKombat4Source}
        sourceProfile={mortalKombat4Profile}
        sourcePath="game.chd"
        setSourcePath={vi.fn()}
        bios={bios}
        biosPath={bios.path}
        setBiosPath={vi.fn()}
        biosProfile={psxBiosProfile}
        actions={actions}
        status={{
          ...portStatus(),
          active: installRecord(),
          readiness: {
            launchable: health === "current",
            blockers: [],
            pending_setup: false,
            source: "current",
            bios: health,
          },
        }}
      />,
    );
    expect(html).toContain(note.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Registered BIOS file");
    expect(html).toContain(`Saved SHA-256</strong><code>${bios.sha256}</code>`);
  });

  it("keeps missing health data unknown even when saved game files exist", () => {
    const source = {
      profile_id: "sample-rom",
      path: "source.z64",
      sha256: "a".repeat(64),
      size: 12,
      storage_sha256: "a".repeat(64),
      storage_size: 12,
      updated_at: 1,
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        source={source}
        sourcePath={source.path}
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(html).toContain("Game-file check status unavailable");
    expect(html).not.toContain("Files are unchanged since they were added");
  });

  it("shows changed registered bytes as setup instead of launch readiness", () => {
    const source = {
      profile_id: "sample-rom",
      path: "source.z64",
      sha256: "a".repeat(64),
      size: 12,
      storage_sha256: "a".repeat(64),
      storage_size: 12,
      updated_at: 1,
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        source={source}
        sourcePath="source.z64"
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          port_id: port.id,
          channel: "stable",
          update_policy: "notify",
          active: installRecord(),
          readiness: {
            launchable: false,
            blockers: ["changed_source"],
            pending_setup: false,
            source: "changed",
          },
        }}
      />,
    );
    expect(html).toContain("Game files changed");
    expect(html).toContain("Choose and add the game files again before playing.");
    expect(html).toContain("Files have changed since they were added");
    expect(html).toContain("Play unavailable");
    expect(html).not.toContain("Play now");
  });

  it("uses player-facing BIOS recovery copy before playing", () => {
    const bios = {
      profile_id: "psx-scph-1001-bios",
      path: "scph1001.bin",
      sha256: "a".repeat(64),
      size: 524_288,
      storage_sha256: "a".repeat(64),
      storage_size: 524_288,
      updated_at: 1,
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={biosPort}
        source={mortalKombat4Source}
        sourceProfile={mortalKombat4Profile}
        sourcePath="game.chd"
        setSourcePath={vi.fn()}
        bios={bios}
        biosPath="scph1001.bin"
        setBiosPath={vi.fn()}
        pickBios={vi.fn()}
        biosProfile={psxBiosProfile}
        actions={actions}
        status={{
          ...portStatus(),
          port_id: biosPort.id,
          channel: "stable",
          update_policy: "notify",
          active: installRecord(),
          readiness: {
            launchable: false,
            blockers: ["changed_bios"],
            pending_setup: false,
            bios: "changed",
          },
        }}
      />,
    );
    expect(html).toContain("Required BIOS file changed");
    expect(html).toContain("Choose and add the required BIOS file again before playing.");
    expect(html).toContain("BIOS file has changed since it was added");
    expect(html).toContain("Play unavailable");
    expect(html).not.toContain("Play now");
  });

  it("keeps older backups reachable without expanding the detail panel by default", () => {
    const backups = Array.from({ length: 4 }, (_, index) => ({
      id: `backup-${index}`,
      port_id: port.id,
      path: `backups/sample/${index}`,
      created_at: index + 1,
      file_count: 1,
      size: 1024,
      sha256: `${index}`.repeat(64),
    }));
    const html = renderToStaticMarkup(
      <BackupHistory backups={backups} restore={vi.fn()} remove={vi.fn()} />,
    );
    expect(html).toContain("Backups");
    expect(html).toContain("Backups include saves and settings managed by Portcove.");
    expect(html).toContain("4 verified backups");
    expect(html).toContain("Show 1 older");
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*>[^]*?Show 1 older<\/button>/u);
    expect(html).not.toContain("backup-expander");
    for (const backup of backups.slice(0, 3))
      expect(html).toContain(
        `aria-label="Technical details for backup from ${new Date(backup.created_at * 1000).toLocaleString()}"`,
      );
    expect(html).not.toContain("3333333333");
  });

  it("uses count-aware backup wording and keeps checksum identity in technical details", () => {
    const backup = {
      id: "backup-1",
      port_id: port.id,
      path: "backups/sample/backup-1",
      created_at: 1,
      file_count: 1,
      size: 1024,
      sha256: "a".repeat(64),
    };
    const empty = renderToStaticMarkup(
      <BackupHistory backups={[]} restore={vi.fn()} remove={vi.fn()} />,
    );
    const populated = renderToStaticMarkup(
      <BackupHistory backups={[backup]} restore={vi.fn()} remove={vi.fn()} />,
    );
    expect(empty).toContain("No backups yet");
    expect(empty).not.toContain("snapshot");
    expect(populated).toContain("1 verified backup");
    expect(populated).toContain("1 file · 1.0 KiB");
    expect(populated).toContain("Technical details");
    expect(populated).toContain('aria-label="Technical details for backup from ');
    expect(populated).toContain('class="backup-checksum"');
    expect(populated.indexOf(backup.sha256)).toBeGreaterThan(populated.indexOf("<details"));
    expect(populated).not.toContain(`${backup.sha256.slice(0, 10)}…`);
  });

  it("keeps verified backups usable while exposing degraded and recovery details", () => {
    const backups = [
      {
        id: "backup-1",
        port_id: port.id,
        path: "backups/sample/backup-1",
        created_at: 1,
        file_count: 2,
        size: 1024,
        sha256: "a".repeat(64),
      },
    ];
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={backups}
        state="recovery_required"
        problems={[
          {
            kind: "recovery_required",
            backup_id: null,
            operation_id: "operation-1",
            path: "backups/sample/.deleting-operation-1",
            message: "Deletion was interrupted.",
            proposed_action: "Restart Portcove, then review doctor output.",
          },
        ]}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).toContain("Backup recovery required");
    expect(html).toContain("1 verified backup");
    expect(html).toContain("Technical details");
    expect(html).toContain("Deletion was interrupted");
    expect(html).toContain("Restore");
  });

  it("renders navigation, headers, status, and settings content", () => {
    const html = [
      renderToStaticMarkup(
        <Sidebar
          view="library"
          setView={vi.fn()}
          installedCount={2}
          updateCount={1}
          activities={[]}
          onAdopt={vi.fn()}
        />,
      ),
      renderToStaticMarkup(<PageHeader view="catalog" query="sample" setQuery={vi.fn()} />),
      renderToStaticMarkup(
        <StatusLayer
          error="Problem"
          clearError={vi.fn()}
          operation={{
            schema_version: 2,
            parent_operation_id: null,
            target: null,
            operation_id: "install-1",
            sequence: 1,
            timestamp_ms: 1,
            operation: "install",
            type: "progress",
            phase: "install",
            completed: 1,
            total: 2,
          }}
          busy="install"
        />,
      ),
      renderToStaticMarkup(<SettingsView libraryRoot="C:/Portcove" />),
    ].join(" ");
    expect(html).toContain("Copy existing installation");
    expect(html).toMatch(
      /<button[^>]*data-variant="selected"[^>]*aria-current="page"[^>]*>[^]*?Library[^]*?<\/button>/u,
    );
    expect(html).toMatch(
      /<button[^>]*data-variant="outline"[^>]*class="[^"]*whitespace-normal[^"]*"[^>]*>[^]*?Copy existing installation[^]*?<\/button>/u,
    );
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*class="[^"]*bg-transparent/u);
    expect(html).toMatch(
      /<button[^>]*data-variant="outline"[^>]*aria-label="Open command palette"/u,
    );
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*aria-label="Dismiss error"/u);
    expect(html).toContain("Port catalog");
    expect(html).toContain("Problem");
    expect(html).toContain("C:/Portcove");
    expect(html).toContain("width:50%");
    expect(html).toContain("/brand/icons/portcove-mascot-head-256.png");
    expect(html).toContain("ABOUT &amp; CREDITS");
    expect(html).toContain(
      "Portcove keeps the desktop and CLI in sync across the catalog, game files, installed versions, and recovery history.",
    );
    expect(html).toContain("/brand/logo/portcove-logo-v2-transparent.png");
  });

  it("uses semantic shared actions for application update notices", () => {
    const choice = renderToStaticMarkup(
      <StatusLayer
        clearError={vi.fn()}
        updateChoiceRequired
        reviewUpdate={vi.fn()}
        dismissUpdateChoice={vi.fn()}
      />,
    );
    const transition = renderToStaticMarkup(
      <StatusLayer
        clearError={vi.fn()}
        productionTransitionRequired
        useStable={vi.fn()}
        keepPreview={vi.fn()}
        dismissProductionTransition={vi.fn()}
      />,
    );

    expect(choice).toMatch(/data-variant="primary"[^>]*>Review options<\/button>/u);
    expect(choice).toMatch(/data-variant="ghost"[^>]*>Not now<\/button>/u);
    expect(transition).toMatch(/data-variant="primary"[^>]*>Use Stable<\/button>/u);
    expect(transition).toMatch(/data-variant="outline"[^>]*>Keep Preview<\/button>/u);
    expect(transition).toMatch(/data-variant="ghost"[^>]*>Not now<\/button>/u);
  });

  it("keeps page introductions concise without losing catalog count or controls", () => {
    const library = renderToStaticMarkup(<PageHeader view="library" query="" setQuery={vi.fn()} />);
    const emptyCatalog = renderToStaticMarkup(
      <PageHeader view="catalog" query="" setQuery={vi.fn()} portCount={0} />,
    );
    const onePort = renderToStaticMarkup(
      <PageHeader view="catalog" query="" setQuery={vi.fn()} portCount={1} />,
    );
    const catalog = renderToStaticMarkup(
      <PageHeader view="catalog" query="" setQuery={vi.fn()} portCount={61} />,
    );
    const updates = renderToStaticMarkup(<PageHeader view="updates" query="" setQuery={vi.fn()} />);
    const settings = renderToStaticMarkup(
      <PageHeader view="settings" query="" setQuery={vi.fn()} />,
    );

    expect(library).toContain("<h1>Your library</h1>");
    expect(emptyCatalog).toContain("Browse 0 native game ports.");
    expect(onePort).toContain("Browse 1 native game port.");
    expect(catalog).toContain("<h1>Port catalog</h1>");
    expect(catalog).toContain("Browse 61 native game ports.");
    expect(catalog).toContain('id="port-search"');
    expect(updates).toContain("<h1>Updates</h1>");
    expect(settings).toContain("<h1>Settings</h1>");
    for (const header of [library, catalog, updates, settings]) {
      expect(header).not.toContain('class="eyebrow"');
      expect(header).toContain('aria-label="Open command palette"');
    }
    for (const header of [library, updates, settings])
      expect(header).not.toContain('class="page-description"');
  });

  it("keeps current and abandoned activity discoverable from primary navigation", () => {
    const now = Math.floor(Date.now() / 1000);
    const activity = (overrides: Partial<ActivityRecord> = {}): ActivityRecord => ({
      id: "activity",
      operation: "prepare",
      target_kind: "port",
      target_id: port.id,
      status: "running",
      started_at: now,
      finished_at: null,
      failure: null,
      cancellation: null,
      message: null,
      ...overrides,
    });
    const completed = Array.from({ length: 8 }, (_, index) =>
      activity({
        id: `completed-${index}`,
        operation: "launch",
        status: "succeeded",
        started_at: now - index,
        finished_at: now - index,
      }),
    );
    const current = activity({ id: "current", started_at: now - 60 });

    const running = renderToStaticMarkup(
      <Sidebar
        view="library"
        setView={vi.fn()}
        installedCount={1}
        updateCount={2}
        activities={[...completed, current]}
        onAdopt={vi.fn()}
      />,
    );
    expect(running).toContain('aria-label="Activity in progress, 2 updates available"');

    const history = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[port]}
        statuses={new Map()}
        activities={[...completed, current]}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSources={vi.fn()}
      />,
    );
    expect(history).toContain("Prepared game data");
    expect(history).toContain("In progress");

    const abandoned = renderToStaticMarkup(
      <Sidebar
        view="catalog"
        setView={vi.fn()}
        installedCount={1}
        updateCount={0}
        activities={[activity({ started_at: now - 24 * 60 * 60 })]}
        onAdopt={vi.fn()}
      />,
    );
    expect(abandoned).toContain('aria-label="Activity needs attention"');

    const failed = renderToStaticMarkup(
      <Sidebar
        view="catalog"
        setView={vi.fn()}
        installedCount={1}
        updateCount={0}
        activities={[
          activity({
            status: "failed",
            finished_at: now,
            failure: failureReport(),
          }),
        ]}
        onAdopt={vi.fn()}
      />,
    );
    expect(failed).toContain('aria-label="Activity needs attention"');
  });

  it("clears failed preparation attention after a newer successful attempt", () => {
    const base: ActivityRecord = {
      id: "failed",
      operation: "prepare",
      target_kind: "port",
      target_id: port.id,
      status: "failed",
      started_at: 1,
      finished_at: 2,
      failure: failureReport(),
      cancellation: null,
      message: null,
    };
    const html = renderToStaticMarkup(
      <Sidebar
        view="library"
        setView={vi.fn()}
        installedCount={1}
        updateCount={0}
        activities={[
          { ...base, id: "succeeded", status: "succeeded", started_at: 3, finished_at: 4 },
          base,
        ]}
        onAdopt={vi.fn()}
      />,
    );
    expect(html).not.toContain("Activity needs attention");
  });

  it("shows library selection provenance without implying a move", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        librarySelection={{ root: "D:/Portcove Library", source: "saved" }}
        chooseLibrary={vi.fn()}
        switchLibrary={vi.fn()}
        resetLibrary={vi.fn()}
      />,
    );
    expect(html).toContain("D:/Portcove Library");
    expect(html).toContain("Saved host preference");
    expect(html).toContain("does not move files");
    expect(html).toContain("STORAGE LOCATIONS");
    expect(html).toContain("WHOLE PORTCOVE LIBRARY");
    expect(html).toContain("Review platform default");
    expect(html).toContain("Each game’s Export / install folder is reviewed separately");
    expect(html).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>Review library switch<\/button>/u,
    );
  });

  it("groups every settings capability by the six player-facing tasks", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        appearance={{
          preference: "system",
          resolvedTheme: "light",
          setPreference: vi.fn(),
        }}
      />,
    );
    const groups = Array.from(html.matchAll(/data-settings-group="([^"]+)"/g), (match) => match[1]);
    expect(groups).toEqual([
      "appearance",
      "library-storage",
      "game-files",
      "updates",
      "integrations",
      "advanced",
    ]);
    for (const group of groups) {
      expect(html).toContain(
        `data-settings-group="${group}" aria-labelledby="settings-${group}-heading"`,
      );
      expect(html).toContain(`id="settings-${group}-heading"`);
    }
    const groupMarkup = (group: string) => {
      const start = html.indexOf(`data-settings-group="${group}"`);
      const next = groups[groups.indexOf(group) + 1];
      const end = next ? html.indexOf(`data-settings-group="${next}"`) : html.length;
      return html.slice(start, end);
    };
    expect(groupMarkup("appearance")).toContain("Color theme");
    expect(groupMarkup("library-storage")).toContain("Startup selection");
    expect(groupMarkup("library-storage")).toContain("Files and capacity");
    expect(groupMarkup("game-files")).toContain("Game-file verification");
    expect(groupMarkup("game-files")).toContain("Disc tools");
    expect(groupMarkup("updates")).toContain("Choose how Portcove updates");
    expect(groupMarkup("updates")).toContain("Catalog updates");
    expect(groupMarkup("updates")).toContain(
      'class="settings-section-content settings-section-content-stacked"',
    );
    expect(groupMarkup("integrations")).toContain("Optional authentication");
    const advanced = groupMarkup("advanced");
    expect(advanced.indexOf("Create support bundle")).toBeLessThan(
      advanced.indexOf("Original game files stay local"),
    );
    expect(advanced.indexOf("Original game files stay local")).toBeLessThan(
      advanced.indexOf("One harbor for native ports"),
    );
    expect(html).not.toContain("<nav");
  });

  it("shows the shared library path and volume capacity", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        storage={{
          library_root: "E:/Portcove",
          volume_total_bytes: 1024 ** 4,
          volume_available_bytes: 512 * 1024 ** 3,
        }}
        exportMetadata={vi.fn()}
      />,
    );
    expect(html).toContain("E:/Portcove");
    expect(html).toContain("512 GiB available");
    expect(html).toContain("1.0 TiB total storage capacity");
    expect(html).toContain('aria-label="Available capacity on the library volume"');
    expect(html).toContain("width:50%");
    expect(html).toContain("Installed application files are kept separate from saves and settings");
    expect(html).toContain("Export saved game-file locations and installed-version settings");
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Export metadata<\/button>/u);
    expect(html).not.toContain("recovery-safe");
  });

  it("shows the core host-readiness report with explicit tool states", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        doctor={{
          platform: "windows-x86-64",
          library: {
            library_root: "E:/Portcove",
            volume_total_bytes: 1024,
            volume_available_bytes: 512,
          },
          catalog_port_count: 61,
          catalog_provenance: {
            origin: "embedded",
            catalog_sha256: "a".repeat(64),
            sequence: null,
            key_id: null,
            expires_at: null,
            fallback_reasons: [],
          },
          installed_port_count: 10,
          registered_source_count: 9,
          repair: { generated_at: 1, items: [] },
          host_tools: [
            {
              id: "chdman",
              display_name: "chdman",
              state: "available",
              path: "C:/Tools/chdman.exe",
              source: "discovery",
              configuration_variable: "PORTCOVE_CHDMAN",
              purpose: "CHD validation and disc-image materialization",
              official_url: "https://docs.mamedev.org/tools/chdman.html",
            },
            {
              id: "dolphin_tool",
              display_name: "DolphinTool",
              state: "misconfigured",
              path: "E:/Missing/DolphinTool.exe",
              source: "environment",
              configuration_variable: "PORTCOVE_DOLPHIN_TOOL",
              purpose: "compressed GameCube validation and ISO materialization",
              official_url: "https://dolphin-emu.org/download/",
            },
            {
              id: "future_tool",
              display_name: "Future tool",
              state: "missing",
              path: null,
              source: null,
              configuration_variable: "PORTCOVE_FUTURE_TOOL",
              purpose: "future source conversion",
              official_url: "https://example.com/tool",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Disc tools");
    expect(html).toContain("windows-x86-64");
    expect(html).toContain("61 ports · 10 installed · 9 sources");
    expect(html).toContain("Ready");
    expect(html).toContain("Check path");
    expect(html).toContain("Not found");
    expect(html).toContain("C:/Tools/chdman.exe");
    expect(html).toContain("E:/Missing/DolphinTool.exe");
    expect(html).toContain("Set PORTCOVE_FUTURE_TOOL");
    expect(html).toContain("Official site");
    expect(html).toContain("Locate executable");
    expect(html).toContain("Recheck");
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Official site<\/button>/u);
  });

  it("labels unavailable diagnostics instead of presenting them as healthy", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        diagnosticsStale
        diagnosticFailure={new Error("host probe failed")}
        refreshDiagnostics={vi.fn()}
      />,
    );
    expect(html).toContain("Diagnostics could not be checked");
    expect(html).toContain("Host readiness is unavailable until diagnostics succeed");
    expect(html).toContain("Retry diagnostics");
    expect(html).not.toContain("Diagnostics are current");
  });

  it("explains support-bundle and optional disc-tool boundaries", () => {
    const html = renderToStaticMarkup(
      <SettingsView createSupportBundle={vi.fn()} refreshDiagnostics={vi.fn()} />,
    );

    expect(html).toContain("Create support bundle");
    expect(html).toContain(
      "Collect recent logs, operation history, and system details without game-file contents or saved credentials.",
    );
    expect(html).toContain("Review what can remain before sharing");
    expect(html).toContain("Paths, file names, port and tool identifiers, timestamps");
    expect(html).toContain("Review the bundle before sharing it");
    expect(html).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>Create support bundle<\/button>/u,
    );
    expect(html).toContain("Checking disc-tool availability");
    expect(html).toContain(
      "These optional tools are used only when Portcove must check, extract, or convert supported compressed disc formats.",
    );
    expect(html).not.toContain("privacy-safe");
  });

  it("renders an accessible system, dark, and light appearance choice", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        appearance={{
          preference: "system",
          resolvedTheme: "light",
          setPreference: vi.fn(),
        }}
      />,
    );
    expect(html).toContain("THEME");
    expect(html).toContain('aria-label="Color theme"');
    expect(html).toContain("Following system · currently Light");
    expect(html).toMatch(
      /<button[^>]*data-variant="selected"[^>]*aria-pressed="true"[^>]*>System<\/button>/u,
    );
    expect(html).toMatch(
      /<button[^>]*data-variant="ghost"[^>]*aria-pressed="false"[^>]*>Dark<\/button>/u,
    );
  });

  it("keeps recovery controls available for rejected saved sign-ins and explains environment overrides", () => {
    for (const [source, message, showsRecovery, showsPasswordEntry] of [
      ["credential_store", "GitHub no longer accepts the saved sign-in", true, true],
      ["environment", "Replace or remove it outside Portcove", false, false],
    ] as const) {
      const html = renderToStaticMarkup(
        <SettingsView
          github={{
            status: {
              source,
              authenticated: false,
              login: null,
              rate_limit: null,
              device_login_available: true,
            },
            token: "",
            setToken: vi.fn(),
            saveToken: vi.fn(),
            logout: vi.fn(),
            beginDeviceLogin: vi.fn(),
            refresh: vi.fn(),
          }}
        />,
      );
      const signIn = html.match(/<button\b([^>]*)>Sign in with GitHub<\/button>/);
      const logout = html.match(/<button\b([^>]*)>Log out<\/button>/);
      expect(html).toContain(message);
      expect(signIn !== null).toBe(showsRecovery);
      expect(logout !== null).toBe(showsRecovery);
      expect(signIn?.[1] ?? "").not.toMatch(/\sdisabled(?:=""|\s|$)/u);
      expect(logout?.[1] ?? "").not.toMatch(/\sdisabled(?:=""|\s|$)/u);
      expect(signIn?.[1]?.includes('data-variant="primary"') ?? false).toBe(showsRecovery);
      expect(logout?.[1]?.includes('data-variant="outline"') ?? false).toBe(showsRecovery);
      expect(html.includes('type="password"')).toBe(showsPasswordEntry);
    }
  });

  it("shows GitHub authentication source and rate allowance without exposing a token", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        github={{
          status: {
            source: "credential_store",
            authenticated: true,
            login: "port-user",
            rate_limit: { limit: 5000, remaining: 4998, resets_at: 1 },
            device_login_available: true,
          },
          token: "",
          setToken: vi.fn(),
          saveToken: vi.fn(),
          logout: vi.fn(),
          beginDeviceLogin: vi.fn(),
          refresh: vi.fn(),
        }}
      />,
    );
    expect(html).toContain("Connected as port-user");
    expect(html).toContain("4,998 of 5,000 GitHub requests remaining");
    expect(html).toContain("Operating-system credential store");
    expect(html).not.toContain("Personal access token");
  });

  it("hides unavailable device sign-in without exposing build configuration", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        github={{
          status: {
            source: "anonymous",
            authenticated: false,
            login: null,
            rate_limit: null,
            device_login_available: false,
          },
          token: "",
          deviceLogin: {
            expires_at: 10,
            interval_seconds: 5,
            session_id: "stale-device-session",
            user_code: "STALE-CODE",
            verification_uri: "https://github.example/device",
          },
          setToken: vi.fn(),
          saveToken: vi.fn(),
          logout: vi.fn(),
          beginDeviceLogin: vi.fn(),
          refresh: vi.fn(),
        }}
      />,
    );

    expect(html).toContain("Sign in to GitHub for a higher release-check limit");
    expect(html).toContain("GitHub request limit unavailable");
    expect(html).toContain("Continue anonymously or use a personal access token");
    expect(html).toContain('aria-label="GitHub personal access token"');
    expect(html).not.toContain("Sign in with GitHub");
    expect(html).not.toContain("STALE-CODE");
    expect(html).not.toContain("https://github.example/device");
    expect(html).not.toContain("client ID");
  });

  it("shows read-only source integrity outcomes", () => {
    const source = {
      profile_id: "sample-rom",
      path: "D:/ROMs/sample.z64",
      sha256: "a".repeat(64),
      size: 1024,
      storage_sha256: "a".repeat(64),
      storage_size: 1024,
      updated_at: 1,
    };
    const inspection: SourceInspectionReport = {
      schema_version: 1,
      profile_id: source.profile_id,
      health: "current",
      state_code: "recognized_exact",
      summary: "The source matches one exact catalog identity.",
      next_action: "Review the dependent port requirements before setup.",
      registered: source,
      applications: [],
      evidence: [],
      legacy: {
        registration_identity_not_recorded: true,
        variant_unspecified_records: [],
      },
    };
    const verified = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceRequirementsState="available"
        sources={[source]}
        sourceProfiles={[{ ...sourceProfile(), id: source.profile_id, label: "Sample cartridge" }]}
        sourceOutcomes={[
          {
            profile_id: source.profile_id,
            ok: true,
            error: null,
            result: { ...source, registered_at: 1, verified_at: 2, inspection },
          },
        ]}
        sourceInspections={new Map([[source.profile_id, inspection]])}
        verifySources={vi.fn()}
        replaceSource={vi.fn()}
      />,
    );
    const failed = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceRequirementsState="available"
        sources={[source]}
        sourceOutcomes={[
          {
            profile_id: source.profile_id,
            ok: false,
            result: null,
            error: failureReport(),
          },
        ]}
        verifySources={vi.fn()}
      />,
    );
    expect(verified).toContain("Exact match");
    expect(verified).toContain("Sample cartridge");
    expect(verified).not.toContain("Saved game-file requirement unavailable");
    expect(verified).toContain("Full identity and evidence");
    expect(verified).toContain("D:/ROMs/sample.z64");
    expect(verified).toContain("Relink source");
    expect(verified).toMatch(/<button[^>]*data-variant="outline"[^>]*>Relink source<\/button>/u);
    expect(failed).toContain("Needs attention");
    expect(failed).toContain("source changed since registration");
  });

  it("keeps a removed source-profile identity in technical details with removal available", () => {
    const source = {
      profile_id: `removed-${"profile".repeat(12)}`,
      path: "D:/ROMs/retained-source.bin",
      sha256: "a".repeat(64),
      size: 1024,
      storage_sha256: "a".repeat(64),
      storage_size: 1024,
      updated_at: 1,
    };
    const otherSource = {
      ...source,
      profile_id: "other-removed-profile",
    };
    const html = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceRequirementsState="available"
        sources={[source, otherSource]}
        sourceProfiles={[]}
        replaceSource={vi.fn()}
      />,
    );

    expect(html).toContain("Saved game-file requirement unavailable");
    expect(html).toContain(
      "This saved game-file requirement is no longer present in the current catalog.",
    );
    expect(html).toContain("Update the catalog or remove the saved location.");
    expect(html).toContain(
      `Catalog profile ID: <code class="source-profile-id">${source.profile_id}</code>`,
    );
    expect(html).toContain(
      `aria-label="Technical details for saved game-file location ${source.path}, saved reference 1 of 2"`,
    );
    expect(html).toContain(
      `aria-label="Technical details for saved game-file location ${otherSource.path}, saved reference 2 of 2"`,
    );
    expect(html).not.toContain(`<strong>${source.profile_id}</strong>`);
    expect(html).not.toContain(">Relink source</button>");
    expect(html).toContain("Remove reference");
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("Checking identity");
  });

  it("shows the saved registered path as inspected and keeps a replacement path unchecked", () => {
    const source = {
      profile_id: "sample-rom",
      path: "D:/ROMs/registered.z64",
      sha256: "a".repeat(64),
      size: 1024,
      storage_sha256: "a".repeat(64),
      storage_size: 1024,
      updated_at: 1,
    };
    const inspection: SourceInspectionReport = {
      schema_version: 1,
      profile_id: source.profile_id,
      health: "current",
      state_code: "recognized_exact",
      summary: "Exact registered identity.",
      next_action: "Continue.",
      registered: source,
      applications: [],
      evidence: [],
      legacy: {
        registration_identity_not_recorded: false,
        variant_unspecified_records: [],
      },
    };
    const saved = renderToStaticMarkup(
      <DetailPanel
        port={port}
        source={source}
        sourceInspection={inspection}
        sourcePath={source.path}
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    const replacement = renderToStaticMarkup(
      <DetailPanel
        port={port}
        source={source}
        sourceInspection={inspection}
        sourcePath="D:/ROMs/replacement.z64"
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(saved).toContain("Exact match");
    expect(saved).toContain("Exact registered identity.");
    expect(saved).not.toContain("Selected path has not been checked");
    expect(saved).not.toContain("Selected game files have not been checked");
    expect(replacement).toContain("Selected path has not been checked");
    expect(replacement).toContain("Selected game files have not been checked");
    expect(replacement).not.toContain("Exact registered identity.");
  });

  it("surfaces missing installed-library source requirements in settings", () => {
    const requirement = {
      profile: {
        ...sourceProfile(),
        id: "sample-set",
        label: "Sample source set",
        kind: "file-set" as const,
        accepted_extensions: [],
      },
      requiredBy: [{ portId: port.id, portName: port.name, role: "Game source" as const }],
    };
    const registeredSource = {
      profile_id: requirement.profile.id,
      path: "D:/ROMs/loading-source.bin",
      sha256: "a".repeat(64),
      size: 1024,
      storage_sha256: "a".repeat(64),
      storage_size: 1024,
      updated_at: 1,
    };
    const unavailableInputs = {
      libraryRoot: "C:/Portcove",
      sources: [registeredSource],
      sourceProfiles: [requirement.profile],
    };
    const loading = renderToStaticMarkup(<SettingsView {...unavailableInputs} />);
    const unavailable = renderToStaticMarkup(
      <SettingsView {...unavailableInputs} sourceRequirementsState="unavailable" />,
    );
    const noInstalledPorts = renderToStaticMarkup(
      <SettingsView libraryRoot="C:/Portcove" sourceRequirementsState="available" />,
    );
    const complete = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceRequirementsState="available"
        installedCount={1}
      />,
    );
    const singular = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceNeeds={[requirement]}
        sourceRequirementsState="available"
        addSource={vi.fn()}
      />,
    );
    const plural = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceNeeds={[
          requirement,
          {
            ...requirement,
            profile: { ...requirement.profile, id: "second-set", label: "Second source set" },
          },
        ]}
        sourceRequirementsState="available"
        addSource={vi.fn()}
      />,
    );

    expect(loading).toContain("Checking required game files");
    expect(loading).not.toContain("Required game files have been added");
    expect(loading).not.toContain("No ports installed yet");
    expect(loading).not.toContain("No source files are registered yet");
    expect(loading.match(/<button\b([^>]*)>Choose game files<\/button>/)?.[1]).toContain(
      "disabled",
    );
    expect(loading).not.toContain(requirement.profile.label);
    expect(loading).not.toContain(registeredSource.path);
    expect(unavailable).toContain("Required game files could not be checked");
    expect(unavailable).toContain("Retry loading the library before changing saved locations");
    expect(unavailable).not.toContain("Required game files have been added");
    expect(unavailable).not.toContain("No ports installed yet");
    expect(unavailable).not.toContain("No source files are registered yet");
    expect(unavailable.match(/<button\b([^>]*)>Choose game files<\/button>/)?.[1]).toContain(
      "disabled",
    );
    expect(unavailable).not.toContain(requirement.profile.label);
    expect(unavailable).not.toContain(registeredSource.path);
    expect(noInstalledPorts).toContain(
      "No ports installed yet. Game-file requirements for installed ports will appear here.",
    );
    expect(noInstalledPorts).not.toContain("source-requirements complete");
    expect(complete).toContain("Required game files have been added for your installed ports");
    expect(complete).toContain("source-requirements complete");
    expect(complete).toContain("No source files are registered yet");
    expect(singular).toContain("1 game-file requirement needs attention");
    expect(plural).toContain("2 game-file requirements need attention");
    expect(singular).toContain("Game-file verification");
    expect(singular).toContain("Portcove checks files locally and never uploads or changes them");
    expect(singular).toContain("confirms that the file is an exact match");
    expect(singular).toContain("Sample source set");
    expect(singular).toContain("Sample Port · Game source");
    expect(singular).toContain("Add source");
    expect(singular).toContain("Add ZIP");
    expect(singular).toMatch(/<button[^>]*data-variant="outline"[^>]*>Add source<\/button>/u);
    expect(singular).not.toContain("source requirement needs attention");
  });

  it.each([null, installRecord(), installRecord({ verified: false })])(
    "does not infer blanket assurances from an install record",
    (active) => {
      const html = renderToStaticMarkup(
        <DetailPanel
          port={port}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
          status={{
            ...portStatus(),
            port_id: port.id,
            channel: "stable",
            update_policy: "notify",
            active,
          }}
        />,
      );
      expect(html).not.toContain("Verified releases");
      expect(html).not.toContain("Rollback retained");
      expect(html).not.toContain("Saves protected");
      expect(html).not.toContain("Previous version recorded");
    },
  );

  it("reports a recorded previous version without promising rollback or save compatibility", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          port_id: port.id,
          channel: "stable",
          update_policy: "notify",
          active: installRecord(),
          previous: installRecord({ version: "0.9" }),
        }}
      />,
    );
    expect(html).toContain("Previous version recorded · 0.9");
    expect(html).not.toContain("Rollback retained");
    expect(html).not.toContain("Saves protected");
  });

  it("keeps an unchecked selected path eligible for install review without calling it checked", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath="selected.z64"
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(html).toContain("Selected game files have not been checked");
    expect(html).toContain("Selected path has not been checked");
    const review = html
      .match(/<button[^>]*>[^]*?Review install<\/button>/g)
      ?.at(-1)
      ?.split("<button")
      .at(-1);
    expect(review).toBeDefined();
    expect(review).not.toMatch(/\sdisabled(?:=""|[\s>])/u);
    expect(html).not.toContain("Ready to launch");
  });

  it("treats null and omitted source health equally while preserving the core launch block", () => {
    const render = (health: null | undefined) =>
      renderToStaticMarkup(
        <DetailPanel
          port={port}
          sourcePath="selected.z64"
          setSourcePath={vi.fn()}
          actions={actions}
          status={{
            ...portStatus(),
            port_id: port.id,
            active: installRecord(),
            readiness: {
              launchable: false,
              blockers: ["missing_source"],
              pending_setup: false,
              source: health,
            },
          }}
        />,
      );
    const html = render(null);
    expect(html).toBe(render(undefined));
    expect(html).toContain("Selected path has not been checked");
    expect(html).not.toContain("Ready to launch");
  });

  it("does not turn a selected override into registered-source readiness", () => {
    const source = {
      profile_id: "sample-rom",
      path: "registered.z64",
      sha256: "a".repeat(64),
      size: 12,
      storage_sha256: "a".repeat(64),
      storage_size: 12,
      updated_at: 1,
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        source={source}
        sourcePath="new.z64"
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          port_id: port.id,
          channel: "stable",
          update_policy: "notify",
          active: installRecord(),
          readiness: {
            source: "current",
            launchable: true,
            blockers: [],
            pending_setup: false,
          },
        }}
      />,
    );
    expect(html).toContain("Game files need checking");
    expect(html).toContain("Selected path has not been checked");
    expect(html).not.toContain("Current registered bytes checked");
    expect(html).not.toContain("Ready to launch");
    expect(html).toContain("Play now");
  });

  it("renders installed and uninstalled detail actions", () => {
    const uninstalled = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        pickSource={vi.fn()}
        actions={actions}
      />,
    );
    const sourceFree = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      user_data_root: "C:/Portcove/user/sample",
      channel: "stable",
      update_policy: "notify",
      active: installRecord(),
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
        source: "current",
      },
    };
    const installed = renderToStaticMarkup(
      <DetailPanel
        port={port}
        status={status}
        sourcePath="source.z64"
        setSourcePath={vi.fn()}
        actions={actions}
        backups={[
          {
            id: "backup-1",
            port_id: port.id,
            path: "backups/sample/backup-1",
            created_at: 1,
            file_count: 2,
            size: 1024,
            sha256: "a".repeat(64),
          },
        ]}
      />,
    );
    const buttonLabels = [...installed.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(
      ([, content]) => content.replaceAll(/<[^>]+>/g, "").trim(),
    );
    expect(uninstalled).toContain("Choose game files");
    expect(uninstalled).toContain("Add all required game files before installing");
    expect(uninstalled).toContain("Choose the required game file");
    expect(uninstalled).toContain(
      "Portcove uses this game file in place and never uploads or changes it.",
    );
    expect(sourceFree).toContain("Review install");
    expect(sourceFree).not.toContain("Choose game files");
    expect(sourceFree).toContain('data-slot="button"');
    expect(sourceFree).toContain('data-variant="primary"');
    expect(installed).toContain("Play");
    expect(installed).toMatch(/<button[^>]*data-variant="primary"[^>]*>[^]*?Play now<\/button>/u);
    expect(installed).toMatch(/<button[^>]*data-variant="ghost"[^>]*>[^]*?Back<\/button>/u);
    expect(installed).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>[^]*?Check for updates<\/button>/u,
    );
    expect(installed).toMatch(
      /<button[^>]*data-variant="destructive"[^>]*aria-label="Delete backup/u,
    );
    expect(buttonLabels).toContain("Check for updates");
    expect(installed).toContain("Open data folder");
    expect(installed).toContain("Back up data");
    expect(installed).toContain('title="Back up saves and settings"');
    expect(buttonLabels).toContain("Verify installation");
    expect(buttonLabels).toContain("Restore previous version");
    expect(buttonLabels).not.toContain("Check update");
    expect(buttonLabels).not.toContain("Verify");
    expect(buttonLabels).not.toContain("Rollback");
    expect(installed).not.toContain("Create a versioned backup of saves and settings");
    expect(installed).toContain("1 verified backup");
    expect(installed).toContain("Restore");
    expect(installed).toContain("Delete");
    expect(installed).toContain("Remove managed files");
    expect(installed).toContain("source.z64");
    expect(uninstalled).not.toContain('<details class="advanced-settings" open="">');
    expect(installed).not.toContain('<details class="advanced-settings" open="">');
    expect(installed).toContain("Saves and settings folder");
    expect(installed).toContain("C:/Portcove/user/sample");
    expect(installed).toContain("No completed device test");
    expect(installed).toContain("Launch from another app");
    expect(installed).toContain("Finding the command-line app");
    expect(installed).not.toContain("portcove exec sample --");
    expect(installed).toContain("Open upstream project");
  });

  it("keeps an untested port in the default catalog", () => {
    const untestedPort = {
      ...port,
      automated_tested_platforms: [],
      manually_validated_platforms: [],
      source_profile: null,
    };
    const catalog = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[untestedPort]}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(catalog).toContain("Sample Port");

    const details = renderToStaticMarkup(
      <DetailPanel port={untestedPort} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(details).toContain("Not yet tested");
    expect(details).toContain("No completed device test");
  });

  it("scopes mixed testing evidence by platform", () => {
    const mixedEvidencePort = {
      ...port,
      platforms: ["windows-x86-64", "linux-x86-64", "macos-aarch64"],
      automated_tested_platforms: ["linux-x86-64", "windows-x86-64", "windows-x86-64"],
      manually_validated_platforms: ["windows-x86-64", "windows-x86-64"],
      source_profile: null,
    } satisfies PortDefinition;
    const eligible = renderToStaticMarkup(
      <DetailPanel
        port={mixedEvidencePort}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(eligible).toContain("Windows · Linux · Not recorded: Apple silicon");
    expect(eligible).toContain("Windows · Not recorded: Linux · Apple silicon");
  });

  it("explains the folder contract for a multi-disc source", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={currentCatalogPort("final-fantasy-vii-recompiled")}
        sourceProfile={{
          ...sourceProfile(),
          id: "final-fantasy-vii-psx",
          label: "Final Fantasy VII (USA) three-disc set",
          kind: "psx-disc",
          accepted_extensions: ["chd"],
          disc: {
            track_counts: [1],
            discs: [
              {
                accepted_sha1: ["1f890164ac4daeba07def64bb5b636bfaa1d3ab9"],
                accepted_sha256: [
                  "385d416b651f8ab2a9dee78718e6dd7ae5d83af37507395b990c4d7923d9e5bd",
                ],
                accepted_volume_ids: [],
                label: "Disc 1",
                track_counts: [1],
              },
              {
                accepted_sha1: ["9b8456c661722b032e24f2596840b06ea5cbdd46"],
                accepted_sha256: [
                  "1b9c745af8f68bf58dcbb464c3bb0c16bfa87b72d99bfa6b39615fa052ce681a",
                ],
                accepted_volume_ids: [],
                label: "Disc 2",
                track_counts: [1],
              },
              {
                accepted_sha1: ["0d9614fcd1288bbff2c53e690c6f626d3ac28fd0"],
                accepted_sha256: [
                  "9afd82845c2b0388335c4bee04d78e946ae683c473a5f5c567cd944e11190414",
                ],
                accepted_volume_ids: [],
                label: "Disc 3",
                track_counts: [1],
              },
            ],
          },
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        pickSource={vi.fn()}
        actions={actions}
      />,
    );
    const buttonLabels = [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(([, content]) =>
      content.replaceAll(/<[^>]+>/g, "").trim(),
    );
    expect(html).toContain("Final Fantasy VII (USA) three-disc set");
    expect(html).toContain("Choose the folder that contains all required game discs");
    expect(html).toContain("Portcove checks this folder without uploading or changing it.");
    expect(buttonLabels.filter((label) => label === "Choose game files")).toHaveLength(2);
  });

  it("explains folder and ZIP choices for an exact game-file set", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={currentCatalogPort("g-diffuser")}
        sourceProfile={{
          ...sourceProfile(),
          id: "g-diffuser-source-set",
          label: "F-Zero X G-Diffuser cartridge, Expansion Kit, and 64DD IPL set",
          kind: "file-set",
          accepted_extensions: [],
          members: [
            {
              id: "cartridge",
              label: "F-Zero X (USA Rev 0) cartridge",
              accepted_filenames: ["baserom.us.rev0.z64"],
              accepted_sha1: ["5f658e88ffa9de23cba6986a8fd3d3a90d7b4340"],
              accepted_sha256: ["2be0f861c30752bbdfa727753a454108bc973c27ad814744f191b1278c1f482d"],
              accepted_crc32: [],
            },
            {
              id: "expansion-kit",
              label: "English translated F-Zero X Expansion Kit disk",
              accepted_filenames: ["baserom.translated.ek.ndd"],
              accepted_sha1: ["fde9fa6f29a52be0144bda74caf8583c036c20ce"],
              accepted_sha256: [],
              accepted_crc32: [],
            },
            {
              id: "ipl",
              label: "Nintendo 64DD IPL",
              accepted_filenames: ["N64DDIPLROM.n64", "64DD_IPL_US_MJR.n64"],
              accepted_sha1: [
                "bf861922dcb78c316360e3e742f4f70ff63c9bc3",
                "3c5b93ca231550c68693a14f03cea8d5dbd1be9e",
              ],
              accepted_sha256: [],
              accepted_crc32: [],
            },
          ],
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        pickSource={vi.fn()}
        pickSourceArchive={vi.fn()}
        actions={actions}
      />,
    );
    const buttonLabels = [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(([, content]) =>
      content.replaceAll(/<[^>]+>/g, "").trim(),
    );
    expect(html).toContain("Choose the folder or ZIP file that contains the required game files");
    expect(html).toContain("Portcove checks this location without uploading or changing it.");
    expect(buttonLabels.filter((label) => label === "Choose game files")).toHaveLength(2);
    expect(buttonLabels).toContain("Choose ZIP file");
  });

  it("renders an independently selectable required BIOS", () => {
    const unselected = renderToStaticMarkup(
      <DetailPanel
        port={biosPort}
        source={mortalKombat4Source}
        sourceProfile={mortalKombat4Profile}
        sourcePath="game.chd"
        setSourcePath={vi.fn()}
        biosPath=""
        setBiosPath={vi.fn()}
        pickBios={vi.fn()}
        biosProfile={psxBiosProfile}
        actions={actions}
      />,
    );
    expect(unselected).toContain("Required BIOS");
    expect(unselected).toContain("PlayStation SCPH-1001 BIOS");
    expect(unselected).toContain("Choose the required BIOS file");
    expect(unselected).toContain(
      "Portcove uses this BIOS file in place and never uploads or changes it.",
    );
    expect(unselected).toContain("Choose BIOS file");
    const unselectedButtons = [...unselected.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(
      ([, content]) => content.replaceAll(/<[^>]+>/g, "").trim(),
    );
    expect(unselectedButtons.filter((label) => label === "Choose BIOS file")).toHaveLength(2);
    expect(unselected).toContain("Add the required BIOS file before installing");

    const selected = renderToStaticMarkup(
      <DetailPanel
        port={biosPort}
        source={mortalKombat4Source}
        sourceProfile={mortalKombat4Profile}
        sourcePath="game.chd"
        setSourcePath={vi.fn()}
        biosPath="scph1001.bin"
        setBiosPath={vi.fn()}
        pickBios={vi.fn()}
        biosProfile={psxBiosProfile}
        actions={actions}
      />,
    );
    expect(selected).toContain("scph1001.bin");
    expect(selected).toContain(
      "Selected BIOS file has not been checked. Portcove validates it when you continue.",
    );
    expect(selected).toContain("The selected BIOS file has not been checked");
    expect(selected).not.toContain("Selected game files have not been checked");
    expect(selected).not.toContain(
      "Portcove uses this BIOS file in place and never uploads or changes it.",
    );
  });

  it("names both missing game files and BIOS before install", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={biosPort}
        sourceProfile={mortalKombat4Profile}
        sourcePath=""
        setSourcePath={vi.fn()}
        pickSource={vi.fn()}
        biosProfile={psxBiosProfile}
        biosPath=""
        setBiosPath={vi.fn()}
        pickBios={vi.fn()}
        actions={actions}
      />,
    );
    const primary = html.match(/<div class="actions primary-actions">(.*?)<\/div>/s)?.[1];
    expect(primary).toContain("Choose game files and BIOS");
    expect(primary).toContain("Add all required game files and the BIOS file before installing");
  });

  it("offers activation when an update is staged", () => {
    const install = installRecord();
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "stage",
      active: install,
      staged: { ...install, id: "2", version: "2.0", staged: true },
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        status={status}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(html).toContain("Activate staged");
  });

  it("renders port cards and empty states", () => {
    const overview = { installed: 0, ready: 0, needsSetup: 0, staged: 0 };
    const cards = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[port]}
        statuses={new Map()}
        overview={overview}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    const empty = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[]}
        statuses={new Map()}
        overview={overview}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    const emptyLibrary = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={overview}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    const filteredEmptyLibrary = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={{ ...overview, installed: 2, needsSetup: 2 }}
        filter="setup"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        clearFilters={vi.fn()}
        loading={false}
      />,
    );
    const loading = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={overview}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading
      />,
    );
    expect(cards).toContain("Sample Port");
    expect(cards).toContain("Available");
    expect(cards).toContain("Windows");
    expect(cards).toContain(port.summary);
    expect(cards).toContain('<div class="platforms">');
    expect(cards).not.toContain('<span class="badge stable">Stable</span>');
    expect(cards).not.toContain("staged-source-portable");
    expect(empty).toContain("No ports match these filters");
    expect(empty).toContain("Try another search or change the filters.");
    expect(empty).not.toContain("The catalog itself has not been changed.");
    expect(empty).toContain("Clear search and filters");
    expect(emptyLibrary).toContain("/brand/mascot/portcove-mascot-v2-front.png");
    expect(emptyLibrary).toContain('aria-hidden="true"');
    expect(emptyLibrary).toContain("No installed ports yet");
    expect(emptyLibrary).toContain("copy an existing supported installation");
    expect(emptyLibrary.toLowerCase()).not.toContain("adopt");
    expect(emptyLibrary).not.toContain("Clear search and filters");
    expect(filteredEmptyLibrary).toContain("No installed ports match your search and filters");
    expect(filteredEmptyLibrary).toContain("Clear search and filters");
    expect(filteredEmptyLibrary).toContain("Clear the search or change the readiness filter.");
    expect(filteredEmptyLibrary).not.toContain("Your installed ports are still in this library.");
    expect(filteredEmptyLibrary).not.toContain("No installed ports yet");
    expect(loading).toContain("/brand/logo/portcove-logo-v2-transparent.png");
    expect(loading).toContain('alt="Portcove"');
    expect(loading).toContain(
      "Loading the catalog, added game files, and installed ports from this device.",
    );
    expect(loading).not.toContain("shared local catalog");
  });

  it("keeps adapter internals out of the primary detail view", () => {
    const html = renderToStaticMarkup(
      <DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(html).toContain("Windows");
    expect(html).toContain("Installation method");
    expect(html).toContain("Prepared game files beside the port");
    expect(html).toContain("Sample cartridge");
    expect(html).toContain("Check method: Known file signatures");
    expect(html).toContain("Version shown when you review installation.");
    expect(html).not.toContain("Compared with reviewed catalog identity");
    expect(html).toContain("Managed by Portcove for backup and restore");
    expect(html).toContain("Active");
    expect(html).toContain("Stable · Beta");
    expect(html).not.toContain("staged-source-portable");
  });

  it("names configured file-check methods without implying a completed check", () => {
    const requirements = port.presentation!.source_requirements;
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          presentation: {
            ...port.presentation!,
            source_requirements: [
              { ...requirements[0], verification: "upstream-validator" },
              { ...requirements[0], role: "bios", verification: "catalog-rules" },
            ],
          },
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(html).toContain("Check method: The port’s validation tool");
    expect(html).toContain("Check method: Required files and format checks");
    expect(html).not.toContain("Checked by the upstream validator");
    expect(html).not.toContain("Checked with catalog-declared file rules");
  });

  it("keeps retired-upstream maintenance distinct from Portcove support", () => {
    const retiredPort: PortDefinition = {
      ...port,
      upstream_status: "retired",
      channels: ["stable"],
      executable_hints: { "windows-x86-64": ["sample.exe"] },
      release: {
        provider: "direct-manifest",
        repository: "",
        rolling_tag: null,
        asset_hints: {},
        direct: {
          "windows-x86-64": {
            version: "1.0.0",
            url: "https://example.com/releases/sample-1.0.0.zip",
            size: 1,
            sha256: "a".repeat(64),
            published_at: null,
          },
        },
      },
    };
    const html = renderToStaticMarkup(
      <DetailPanel port={retiredPort} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(html).toContain("The upstream project is no longer maintained");
    expect(html).toContain("Portcove can still install its pinned release");
    expect(html).toContain("no new upstream fixes are expected");
    expect(html).toContain("<small>Portcove support</small>Stable");
    expect(html).toContain("<small>Available release channels</small>Stable");
    expect(html).toContain("Portcove uses the pinned release recorded in the catalog");
    expect(html).not.toContain("no upstream fixes or support");
    expect(html).not.toContain("Portcove checks this project for releases");
    const library = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[retiredPort]}
        statuses={new Map()}
        overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(library).toContain("Retired upstream");
  });

  it("orders port details by player task and distinguishes installed from eligible versions", () => {
    const install = installRecord();
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          active: install,
          channel: "stable",
          update_policy: "notify",
          user_data_root: "E:/Portcove/user/sample",
          last_update_check: {
            checked_at: 2,
            check: {
              port_id: port.id,
              channel: "stable",
              installed_version: install.version,
              installed_runtime: null,
              required_runtime: null,
              installed_artifact: install.artifact,
              update_available: true,
              release: {
                published_at: null,
                version: "2.0",
                channel: "stable",
                asset: {
                  name: "sample.zip",
                  url: "https://example.com/sample.zip",
                  size: 1,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        }}
      />,
    );
    const headings = [
      "Status and actions",
      "Requirements",
      "Installation and version",
      "Updates",
      "Saves and storage",
      "Compatibility and testing",
      "Project and release",
      "Technical details",
    ];
    let previous = -1;
    for (const heading of headings) {
      const current = html.indexOf(heading);
      expect(current, `${heading} is present`).toBeGreaterThan(previous);
      previous = current;
    }
    expect(html).toContain("Installed version");
    expect(html).toContain("Latest eligible release");
    expect(html).toContain("2.0");
    expect(html).toContain("E:/Portcove/user/sample");
    expect(html.indexOf("Back up data")).toBeLessThan(html.indexOf("Technical details"));
    expect(html).not.toContain("staged-source-portable");
  });

  it("does not present a stale channel check as the selected channel's eligible release", () => {
    const install = installRecord();
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          active: install,
          channel: "beta",
          update_policy: "notify",
          last_update_check: {
            checked_at: 2,
            check: {
              port_id: port.id,
              channel: "stable",
              installed_version: install.version,
              installed_runtime: null,
              required_runtime: null,
              installed_artifact: install.artifact,
              update_available: true,
              release: {
                published_at: null,
                version: "9.9-stale",
                channel: "stable",
                asset: {
                  name: "sample.zip",
                  url: "https://example.com/sample.zip",
                  size: 1,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        }}
      />,
    );
    expect(html).toContain("Selected channel");
    expect(html).toContain("Beta");
    expect(html).toContain("No current check");
    expect(html).not.toContain("9.9-stale");
  });

  it("does not present a check for a replaced installation as the current eligible release", () => {
    const checkedInstall = installRecord();
    const activeInstall = installRecord({ version: "1.1" });
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{
          ...portStatus(),
          active: activeInstall,
          last_update_check: {
            checked_at: 2,
            check: {
              port_id: port.id,
              channel: "stable",
              installed_version: checkedInstall.version,
              installed_runtime: null,
              required_runtime: null,
              installed_artifact: checkedInstall.artifact,
              update_available: true,
              release: {
                published_at: null,
                version: "9.9-stale",
                channel: "stable",
                asset: {
                  name: "sample.zip",
                  url: "https://example.com/sample.zip",
                  size: 1,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        }}
      />,
    );
    expect(html).toContain("Installed version</small>1.1");
    expect(html).toContain("No current check");
    expect(html).not.toContain("9.9-stale");
  });

  it("reveals eligible card targets only during native file drag and keeps a keyboard check in details", () => {
    const overview = { installed: 0, ready: 0, needsSetup: 1, staged: 0 };
    const idle = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[port]}
        statuses={new Map()}
        overview={overview}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    const dragging = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[port]}
        statuses={new Map()}
        overview={overview}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
        nativeSourceDrag={{ active: true, pathCount: 1, targetPortId: port.id }}
      />,
    );
    expect(idle).not.toContain("data-source-drop-profile-id");
    expect(idle).not.toContain("Drop to check");
    expect(dragging).toContain('data-source-drop-profile-id="sample-rom"');
    expect(dragging).toContain("Release to check");
    expect(dragging).toContain("One path selected");

    const details = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourceProfile={{
          ...sourceProfile(),
          id: "sample-rom",
          label: "Sample cartridge",
          kind: "file",
          accepted_extensions: ["z64"],
          accepted_sha1: [],
          accepted_sha256: [],
          disc: null,
          members: [],
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        inspectSource={vi.fn()}
        actions={actions}
      />,
    );
    expect(details).toContain("Check original game files");
  });

  it("summarizes an installed library around play readiness", () => {
    const install = installRecord();
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "notify",
      active: install,
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
        source: "current",
      },
      last_update_check: {
        checked_at: 2,
        check: {
          port_id: port.id,
          channel: "stable",
          installed_version: "1.0",
          installed_runtime: null,
          required_runtime: null,
          installed_artifact: install.artifact,
          update_available: true,
          release: {
            published_at: null,
            version: "2.0",
            channel: "stable",
            asset: {
              name: "sample.zip",
              url: "https://example.com/sample.zip",
              size: 1,
              sha256: "a".repeat(64),
            },
          },
        },
      },
    };
    const html = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }}
        filter="ready"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        onContinue={vi.fn()}
        loading={false}
      />,
    );
    expect(html).toContain("Ready to play");
    expect(html).toContain(">Details</button>");
    expect(html).toContain(`aria-label="More actions for ${port.name}"`);
    expect(html).toContain('data-slot="button"');
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('<small class="card-secondary">Release channel: Stable</small>');
    expect(html).toContain('<article class="port-card port-card-library"');
    expect(html).toContain(">Play</button>");
    expect(html).not.toMatch(/<button[^>]*class="port-card/u);
    expect(html).toContain("Updates downloaded");
    expect(html).toContain("Update available");
    expect(html).toContain("setup and recovery options");
    expect(html).not.toContain("Launch ready");
    expect(html).not.toContain("Play options");
    expect(html).not.toContain("Staged updates");
    expect(html).not.toContain("rollback-safe");
    const card = html.match(
      /<article class="port-card port-card-library"[\s\S]*?<\/article>/u,
    )?.[0];
    expect(card).toBeDefined();
    expect(card?.indexOf("<h2>")).toBeLessThan(card!.indexOf('class="card-kicker"'));
    expect(card).not.toContain(port.summary);
    expect(card).not.toContain('<div class="platforms">');
    expect(card).not.toContain(install.version);
  });

  it("labels a downloaded update without exposing staging terminology", () => {
    const install = installRecord();
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "stage",
      active: install,
      staged: { ...install, id: "2", version: "2.0", staged: true },
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
        source: "current",
      },
    };
    const html = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 1 }}
        filter="ready"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    expect(html).toContain("Update downloaded");
    expect(html).toContain("Updates downloaded");
    expect(html).toContain("Review update");
    expect(html).not.toContain("Update staged");
    expect(html).not.toContain("Staged updates");
  });

  it("offers Continue only from a recorded successful launch", () => {
    const install = installRecord();
    const recentStatus: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "notify",
      active: install,
      last_launched_at: 100,
      successful_launches: 1,
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
        source: "current",
      },
    };
    const html = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, recentStatus]])}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }}
        recent={{ port, status: recentStatus }}
        filter="all"
        setFilter={() => undefined}
        onSelect={() => undefined}
        onContinue={() => undefined}
        loading={false}
      />,
    );
    expect(html).toContain("CONTINUE");
    expect(html).toContain("Play again");
    expect(html).toContain(`Version ${install.version}`);
    expect(html).not.toContain("Last played ·");
    expect(html).toContain('data-successful-launches="1"');
    expect(html).toContain(`data-detail-origin="library:continue-details:${port.id}"`);
    expect(html).toContain(`data-detail-origin="library:card:${port.id}"`);
    expect(html).not.toContain("Last successful session");
  });

  it("routes Continue to setup when previously launched source bytes changed", () => {
    const install = installRecord();
    const recentStatus: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "notify",
      active: install,
      last_launched_at: 100,
      successful_launches: 1,
      readiness: {
        launchable: false,
        blockers: ["changed_source"],
        pending_setup: false,
        source: "changed",
      },
    };
    const html = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, recentStatus]])}
        overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
        recent={{ port, status: recentStatus }}
        filter="all"
        setFilter={() => undefined}
        onSelect={() => undefined}
        onContinue={() => undefined}
        loading={false}
      />,
    );
    expect(html).toContain("Review launch");
    expect(html).not.toContain("Play again");
  });

  it("summarizes update checks and exposes policy reconciliation", () => {
    const install = installRecord();
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "notify",
      active: install,
    };
    const html = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[port]}
        sourceProfiles={[{ ...sourceProfile(), id: "sample-rom", label: "Sample cartridge" }]}
        statuses={new Map([[port.id, status]])}
        activities={[
          {
            id: "activity-1",
            failure: null,
            cancellation: null,
            message: null,
            operation: "update",
            target_kind: "port",
            target_id: port.id,
            status: "succeeded",
            started_at: 1,
            finished_at: 2,
          },
          {
            id: "activity-copy",
            failure: null,
            cancellation: null,
            message: null,
            operation: "adopt",
            target_kind: "port",
            target_id: port.id,
            status: "succeeded",
            started_at: 2,
            finished_at: 3,
          },
          {
            id: "activity-2",
            failure: null,
            cancellation: null,
            operation: "verify_source",
            target_kind: "source",
            target_id: "sample-rom",
            status: "failed",
            message: "source changed",
            started_at: 3,
            finished_at: 4,
          },
          {
            id: "activity-3",
            failure: null,
            cancellation: null,
            message: null,
            finished_at: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "running",
            started_at: 1,
          },
          {
            id: "activity-missing-source",
            failure: null,
            cancellation: null,
            message: null,
            operation: "verify_source",
            target_kind: "source",
            target_id: "removed-profile",
            status: "succeeded",
            started_at: 4,
            finished_at: 5,
          },
          {
            id: "activity-4",
            failure: null,
            cancellation: null,
            message: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "cancelled",
            started_at: 5,
            finished_at: 6,
          },
          {
            id: "activity-5",
            failure: null,
            cancellation: null,
            message: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "future-status" as ActivityRecord["status"],
            started_at: 7,
            finished_at: 8,
          },
          {
            id: "activity-6",
            failure: null,
            cancellation: null,
            message: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "running",
            started_at: Math.floor(Date.now() / 1000),
            finished_at: null,
          },
        ]}
        busy={undefined}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSources={vi.fn()}
        outcomes={[
          {
            port_id: port.id,
            ok: true,
            error: null,
            result: {
              port_id: port.id,
              channel: "stable",
              installed_version: "1.0",
              installed_runtime: null,
              required_runtime: null,
              installed_artifact: null,
              update_available: true,
              release: {
                published_at: null,
                version: "2.0",
                channel: "stable",
                asset: {
                  name: "sample.zip",
                  url: "https://example.com/sample.zip",
                  size: 1,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        ]}
      />,
    );
    expect(html).toContain("2.0");
    expect(html).toContain("Latest eligible");
    expect(html).toContain("Checking only looks for updates");
    expect(html).toContain("Update available");
    expect(html).toContain("Stable · Notify me");
    expect(html).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>[^]*?Check installed ports for updates<\/button>/u,
    );
    expect(html).toContain("Recent activity");
    expect(html).toContain(`data-detail-origin="updates:installed:${port.id}"`);
    expect(html).toContain(`data-detail-origin="updates:activity:activity-1:target"`);
    expect(html).toContain("Updated port");
    expect(html).toContain("Verified source");
    expect(html).toContain("Copied existing installation");
    expect(html).not.toContain("Adopted installation");
    expect(html).toContain("Older activity details are available in a redacted support bundle");
    expect(html).not.toContain("source changed");
    for (const label of [
      "Completed",
      "Failed",
      "Cancelled",
      "Status unavailable",
      "May have been interrupted",
      "In progress",
    ])
      expect(html).toContain(`<span class="activity-status">${label}</span>`);
    expect(html).not.toMatch(/activity-status">(?:succeeded|failed|cancelled|unfinished|running)</);
    expect(html).toContain("No completion reported");
    expect(html).toContain(
      "This task has not reported completion. Review its details before retrying.",
    );
    expect(html).not.toContain("Needs review");
    expect(html).toMatch(
      /<button[^>]*data-variant="link"[^>]*data-focusable="true"[^>]*>Sample cartridge<\/button>/u,
    );
    expect(html).not.toMatch(/>sample-rom<\/button>/u);
    expect(html).toMatch(
      /<button[^>]*data-variant="link"[^>]*data-focusable="true"[^>]*>removed-profile<\/button>/u,
    );
    expect(html).toContain("Activity from the CLI and desktop appears here.");
  });

  it("keeps update policy and last-check states distinct in the installed list", () => {
    const status: PortStatus = { ...portStatus(), active: installRecord() };
    const result: NonNullable<UpdateCheckOutcome["result"]> = {
      port_id: port.id,
      channel: "stable",
      installed_version: "1.0",
      installed_runtime: null,
      required_runtime: null,
      installed_artifact: null,
      update_available: false,
      release: {
        published_at: null,
        version: "1.0",
        channel: "stable",
        asset: {
          name: "sample.zip",
          url: "https://example.com/sample.zip",
          size: 1,
          sha256: "a".repeat(64),
        },
      },
    };
    const render = (current: PortStatus, outcomes: UpdateCheckOutcome[] = []) =>
      renderToStaticMarkup(
        <UpdateCenter
          generation={1}
          ports={[port]}
          statuses={new Map([[port.id, current]])}
          activities={[]}
          outcomes={outcomes}
          diagnosticsRefreshing={false}
          diagnosticsStale={false}
          refreshDiagnostics={vi.fn()}
          checkAll={vi.fn()}
          onSelect={vi.fn()}
          onOpenSources={vi.fn()}
        />,
      );
    for (const [policy, label] of [
      ["notify", "Notify me"],
      ["stage", "Download for later"],
      ["automatic", "Install when running updates"],
    ] as const) {
      expect(render({ ...status, update_policy: policy })).toContain(`Stable · ${label}`);
    }
    const states: Array<[string, PortStatus, UpdateCheckOutcome[]]> = [
      ["Not checked", status, []],
      ["Update saved for later", { ...status, staged: installRecord({ version: "2.0" }) }, []],
      [
        "No update found at last check",
        status,
        [{ port_id: port.id, ok: true, error: null, result }],
      ],
      [
        "Update available",
        status,
        [
          {
            port_id: port.id,
            ok: true,
            error: null,
            result: { ...result, update_available: true },
          },
        ],
      ],
      [
        "Check result unavailable",
        status,
        [{ port_id: port.id, ok: true, error: null, result: null }],
      ],
      [
        "Check failed",
        status,
        [{ port_id: port.id, ok: false, error: failureReport(), result: null }],
      ],
      [
        "Check failed",
        { ...status, staged: installRecord({ version: "2.0" }) },
        [{ port_id: port.id, ok: false, error: failureReport(), result: null }],
      ],
    ];
    for (const [label, current, outcomes] of states)
      expect(render(current, outcomes)).toContain(`>${label}</span>`);
  });

  it("describes activity mutations with outcomes shared producers can support", () => {
    const activities: ActivityRecord[] = [
      {
        id: "activity-backup",
        failure: null,
        cancellation: null,
        message: null,
        operation: "backup",
        target_kind: "port",
        target_id: port.id,
        status: "succeeded",
        started_at: 10,
        finished_at: 11,
      },
      {
        id: "activity-remove",
        failure: null,
        cancellation: null,
        message: null,
        operation: "remove",
        target_kind: "port",
        target_id: port.id,
        status: "succeeded",
        started_at: 11,
        finished_at: 12,
      },
      {
        id: "activity-remove-source",
        failure: null,
        cancellation: null,
        message: null,
        operation: "remove_source",
        target_kind: "source",
        target_id: "sample-rom",
        status: "succeeded",
        started_at: 12,
        finished_at: 13,
      },
      {
        id: "activity-register-source",
        failure: null,
        cancellation: null,
        message: null,
        operation: "register_source",
        target_kind: "source",
        target_id: "sample-rom",
        status: "succeeded",
        started_at: 13,
        finished_at: 14,
      },
      {
        id: "activity-discover-sources",
        failure: null,
        cancellation: null,
        message: null,
        operation: "discover_sources",
        target_kind: "library",
        target_id: null,
        status: "succeeded",
        started_at: 14,
        finished_at: 15,
      },
    ];
    const html = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[port]}
        statuses={new Map()}
        activities={activities}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSources={vi.fn()}
      />,
    );

    for (const label of [
      "Created backup",
      "Removed installed versions",
      "Removed saved game-file location",
      "Saved game-file location",
      "Searched for game files",
    ])
      expect(html).toContain(label);
    for (const internalLabel of [
      "Backed up data",
      "Removed managed files",
      "Removed source reference",
      "Registered source",
      "Added game file",
      "Searched for sources",
    ])
      expect(html).not.toContain(internalLabel);
  });

  it("explains empty update and activity states without internal lifecycle jargon", () => {
    const html = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[]}
        statuses={new Map()}
        activities={[]}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSources={vi.fn()}
      />,
    );
    expect(html).toContain(
      "Install a port or copy in an existing installation first. Portcove will then show its update channel, update setting, latest available release, and previous installed version here.",
    );
    expect(html).toContain("Activity from the CLI and desktop appears here.");
    expect(html).toContain("No activity yet");
    expect(html).toContain(
      "Installs, updates, verification, restored versions, copied installations, and failures will appear here.",
    );
    expect(html.toLowerCase()).not.toContain("adopt");
    expect(html).not.toContain("No operations recorded yet");
  });

  it("distinguishes never-loaded and stale recovery diagnostics from a healthy empty report", () => {
    const neverLoaded = renderToStaticMarkup(
      <RecoveryReview ports={[port]} refreshing={false} stale refresh={vi.fn()} />,
    );
    expect(neverLoaded).toContain('data-diagnostic-state="never-loaded"');
    expect(neverLoaded).toContain("has not been checked");
    expect(neverLoaded).toContain("Refresh recovery information");
    expect(neverLoaded).not.toContain("No recovery items were recorded");

    const stale = renderToStaticMarkup(
      <RecoveryReview
        ports={[port]}
        repair={{ generated_at: 1, items: [] }}
        refreshing
        stale
        refresh={vi.fn()}
      />,
    );
    expect(stale).toContain("last completed check remains visible");
    expect(stale).toContain("No recovery items were recorded");
  });
});
