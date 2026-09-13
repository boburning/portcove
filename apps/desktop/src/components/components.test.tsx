import { failureReport, portDefinition, portStatus, sourceProfile } from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ActivityRecord,
  InstallPlan,
  InstallRecord,
  OperationEvent,
  PortDefinition,
  PortStatus,
  SourceInspectionReport,
} from "../types";
import { PageHeader, SettingsView, Sidebar, StatusLayer } from "./Chrome";
import { BackupHistory } from "./BackupHistory";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { PortBrowser } from "./PortBrowser";
import { UpdateCenter } from "./UpdateCenter";
import { AdoptionModal } from "./AdoptionModal";
import { applyOperationEvent, mostRecentOperation } from "../operation-state";

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
  release: portDefinition().release,
  executable_hints: {},
};
const actions: DetailActions = {
  activate: vi.fn(),
  backup: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
  deleteBackup: vi.fn(),
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

const reviewedInstallPlan = (action: InstallPlan["action"] = "download"): InstallPlan => ({
  bundled_runtime: null,
  port_id: port.id,
  channel: "stable",
  platform: "windows-x86-64",
  action,
  source_requirements: [],
  download_bytes: 64 * 1024 ** 2,
  release: {
    published_at: null,
    version: "2.0",
    channel: "stable",
    asset: {
      name: "sample.zip",
      url: "https://example.com/sample.zip",
      size: 64 * 1024 ** 2,
      sha256: "a".repeat(64),
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
    default_output_directory: "E:/Portcove/versions/sample",
    effective_output_directory: "E:/Portcove/versions/sample",
    selection_source: "library_default",
    user_data_root: "E:/Portcove/user/sample",
  },
});

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
      expect(html).toContain("Backup");
      expect(html).toContain("Working");
      expect(html).not.toContain("Old update");
      expect(html).not.toContain("width:100%");
    }
  });

  it.each(["future-method", "constructor", "__proto__"])(
    "renders unknown installation method %s without assuming support",
    (adapter) => {
      const html = renderToStaticMarkup(
        <DetailPanel
          port={{
            ...port,
            adapter: adapter as PortDefinition["adapter"],
            source_profile: null,
          }}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
        />,
      );
      expect(html).toContain("Installation method unavailable");
      expect(html).not.toContain("[object Object]");
    },
  );

  it("routes a missing verified runtime to reviewed installation instead of Play", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
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
            blockers: ["missing_runtime"],
            pending_setup: false,
          },
        }}
      />,
    );
    expect(html).toContain("Verified runtime required");
    expect(html).toContain("Review game update");
    expect(html).not.toContain("Play now");
    expect(html).not.toContain("Choose required source");
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
    expect(html).toContain("Verify the game files below");
    expect(html).not.toContain("Play now");
    expect(html).not.toContain("Choose required source");
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
    expect(html).toContain("Original source changed");
    expect(html).toContain("Registered source changed since it was added");
    expect(html).toContain("Play unavailable");
    expect(html).not.toContain("Play now");
  });
  it("shows the reviewed adoption copy plan and skipped entries before copying", () => {
    const html = renderToStaticMarkup(
      <AdoptionModal
        path="D:/Existing"
        setPath={vi.fn()}
        close={vi.fn()}
        review={vi.fn()}
        adopt={vi.fn()}
        preview={{
          source: "D:/Existing",
          detected_port_ids: ["sample"],
          selected_port_id: "sample",
          application_files_will_be_copied: true,
          original_will_be_modified: false,
          copy_plan: {
            directories: ["data"],
            files: [
              {
                relative_path: "sample.exe",
                size: 2048,
                sha256: "a".repeat(64),
              },
            ],
            skipped_entries: [
              {
                relative_path: "linked-save",
                reason: "symbolic links are not copied",
              },
            ],
            total_bytes: 2048,
          },
          destination: {
            output_location: {
              port_id: "sample",
              library_root: "D:/Library",
              default_output_directory: "D:/Library/versions/sample",
              configured_output_directory: "E:/Games",
              effective_output_directory: "E:/Games",
              selection_source: "port_setting",
              user_data_root: "D:/Library/user/sample",
            },
            active_install: null,
            imported_user_data_paths: ["settings"],
            current_user_data_files: 2,
            current_user_data_sha256: "c".repeat(64),
          },
          plan_sha256: "b".repeat(64),
        }}
      />,
    );
    expect(html).toContain("1 file · 2.0 KiB");
    expect(html).toContain("1 skipped entry");
    expect(html).toContain("linked-save");
    expect(html).toContain("Continue to copy confirmation");
    expect(html).toContain("E:/Games");
    expect(html).toContain("D:/Library/user/sample");
    expect(html).toContain("Matching saved files are replaced");
    expect(html).toContain("No automatic safety backup");
    expect(html).toContain("cannot cancel");
  });

  it("keeps older backups reachable without expanding the detail panel by default", () => {
    const backups = Array.from({ length: 4 }, (_, index) => ({
      id: `backup-${index}`,
      port_id: port.id,
      path: `backups/sample/${index}`,
      created_at: index + 1,
      file_count: 2,
      size: 1024,
      sha256: `${index}`.repeat(64),
    }));
    const html = renderToStaticMarkup(
      <BackupHistory backups={backups} restore={vi.fn()} remove={vi.fn()} />,
    );
    expect(html).toContain("4 verified snapshots");
    expect(html).toContain("Show 1 older");
    expect(html).not.toContain("3333333333");
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
    expect(html).toContain("1 verified snapshot");
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
    expect(html).toContain("Adopt an install");
    expect(html).toContain("Find a native port");
    expect(html).toContain("Problem");
    expect(html).toContain("C:/Portcove");
    expect(html).toContain("width:50%");
    expect(html).toContain("/brand/icons/portcove-mascot-head-256.png");
    expect(html).toContain("ABOUT &amp; CREDITS");
    expect(html).toContain("/brand/logo/portcove-logo-v2-transparent.png");
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
  });

  it("shows the shared library path and volume capacity", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        storage={{
          library_root: "E:/Portcove",
          volume_total_bytes: 1024 ** 4,
          volume_available_bytes: 512 * 1024 ** 3,
        }}
      />,
    );
    expect(html).toContain("E:/Portcove");
    expect(html).toContain("512 GiB available");
    expect(html).toContain("1.0 TiB volume");
    expect(html).toContain('aria-label="Available library storage"');
    expect(html).toContain("width:50%");
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
    expect(html).toContain("APPEARANCE");
    expect(html).toContain('aria-label="Color theme"');
    expect(html).toContain('aria-pressed="true">System</button>');
    expect(html).toContain('aria-pressed="false">Dark</button>');
    expect(html).toContain('aria-pressed="false">Light</button>');
    expect(html).toContain("Following system · currently Light");
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
      expect(signIn?.[1] ?? "").not.toContain("disabled");
      expect(logout?.[1] ?? "").not.toContain("disabled");
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
    expect(html).toContain("4,998 of 5,000");
    expect(html).toContain("Operating-system credential store");
    expect(html).not.toContain("Personal access token");
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
        sources={[source]}
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
    expect(verified).toContain("Full identity and evidence");
    expect(verified).toContain("D:/ROMs/sample.z64");
    expect(verified).toContain("Relink source");
    expect(failed).toContain("Needs attention");
    expect(failed).toContain("source changed since registration");
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
    expect(replacement).toContain("Selected path has not been checked");
    expect(replacement).not.toContain("Exact registered identity.");
  });

  it("surfaces missing installed-library source requirements in settings", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        libraryRoot="C:/Portcove"
        sourceNeeds={[
          {
            profile: {
              ...sourceProfile(),
              id: "sample-set",
              label: "Sample source set",
              kind: "file-set",
              accepted_extensions: [],
            },
            requiredBy: [{ portId: port.id, portName: port.name, role: "Game source" }],
          },
        ]}
        addSource={vi.fn()}
      />,
    );
    expect(html).toContain("1 source requirement needs attention");
    expect(html).toContain("Sample source set");
    expect(html).toContain("Sample Port · Game source");
    expect(html).toContain("Add source");
    expect(html).toContain("Add ZIP");
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
    expect(review).not.toContain("disabled");
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
    expect(uninstalled).toContain("Choose required source");
    expect(uninstalled).toContain("Choose every required source before installing");
    expect(sourceFree).toContain("Review install");
    expect(sourceFree).not.toContain("Choose required source");
    expect(uninstalled).toContain("Browse");
    expect(installed).toContain("Play");
    expect(installed).toContain("Check update");
    expect(installed).toContain("Open data folder");
    expect(installed).toContain("Back up data");
    expect(installed).toContain("1 verified snapshot");
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

  it("summarizes a resolved install before starting the download", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        installPlan={reviewedInstallPlan()}
      />,
    );
    expect(html).toContain("INSTALL PLAN");
    expect(html).toContain("2.0");
    expect(html).toContain("64.0 MiB");
    expect(html).toContain("512 GiB available");
    expect(html).toContain("Install · 64.0 MiB");
  });

  it("does not describe a blocked local copy as verified", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        installPlan={reviewedInstallPlan("blocked_unverified")}
      />,
    );
    expect(html).toContain("Local copy needs verification");
    expect(html).toContain("Unverified copy blocks install");
    expect(html).not.toContain("Verified local release");
    expect(html).not.toContain("Use verified release");
  });

  it.each(["future_action", "constructor", "__proto__"])(
    "offers only another review for unknown install action %s",
    (action) => {
      const html = renderToStaticMarkup(
        <DetailPanel
          port={{ ...port, source_profile: null }}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
          installPlan={reviewedInstallPlan(action as InstallPlan["action"])}
        />,
      );
      expect(html).toContain("Review install again");
      expect(html).toContain("cannot display the installation plan");
      for (const label of [
        "Use verified release",
        "Verified local release",
        "No download",
        "Install ·",
      ])
        expect(html).not.toContain(label);
    },
  );

  it("explains the folder contract for a multi-disc source", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourceProfile={{
          ...sourceProfile(),
          id: "sample-rom",
          label: "Three-disc set",
          kind: "psx-disc",
          accepted_extensions: ["chd"],
          disc: {
            track_counts: [1],
            discs: [
              {
                accepted_sha1: [],
                accepted_sha256: [],
                accepted_volume_ids: [],
                label: "Disc 1",
                track_counts: [1],
              },
              {
                accepted_sha1: [],
                accepted_sha256: [],
                accepted_volume_ids: [],
                label: "Disc 2",
                track_counts: [1],
              },
              {
                accepted_sha1: [],
                accepted_sha256: [],
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
    expect(html).toContain("Three-disc set");
    expect(html).toContain("folder containing the required sources");
    expect(html).toContain("exactly the required source set");
  });

  it("renders an independently selectable required BIOS", () => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, bios_source_profile: "psx-bios" }}
        sourcePath="game.chd"
        setSourcePath={vi.fn()}
        biosPath="scph1001.bin"
        setBiosPath={vi.fn()}
        pickBios={vi.fn()}
        biosProfile={{
          ...sourceProfile(),
          id: "psx-bios",
          label: "PlayStation SCPH-1001 BIOS",
          accepted_extensions: ["bin"],
        }}
        actions={actions}
      />,
    );
    expect(html).toContain("Required BIOS");
    expect(html).toContain("PlayStation SCPH-1001 BIOS");
    expect(html).toContain("scph1001.bin");
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
    expect(cards).not.toContain("staged-source-portable");
    expect(empty).toContain("No ports match these filters");
    expect(empty).toContain("Clear search and filters");
    expect(emptyLibrary).toContain("/brand/mascot/portcove-mascot-v2-front.png");
    expect(emptyLibrary).toContain('aria-hidden="true"');
    expect(emptyLibrary).toContain("No installed ports yet");
    expect(emptyLibrary).not.toContain("Clear search and filters");
    expect(filteredEmptyLibrary).toContain("No installed ports match your search and filters");
    expect(filteredEmptyLibrary).toContain("Clear search and filters");
    expect(filteredEmptyLibrary).not.toContain("No installed ports yet");
    expect(loading).toContain("/brand/logo/portcove-logo-v2-transparent.png");
    expect(loading).toContain('alt="Portcove"');
  });

  it("keeps adapter internals out of the primary detail view", () => {
    const html = renderToStaticMarkup(
      <DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(html).toContain("Windows");
    expect(html).toContain("Installation method");
    expect(html).toContain("Prepared source beside the game");
    expect(html).not.toContain("staged-source-portable");
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
    expect(html).toContain("Unknown — check for updates");
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
        loading={false}
      />,
    );
    expect(html).toContain("Launch ready");
    expect(html).toContain("Update available");
    expect(html).toContain("setup and recovery options");
    expect(html).not.toContain("rollback-safe");
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
    expect(html).toContain("Last successful session");
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
    expect(html).toContain("Available");
    expect(html).toContain("2.0");
    expect(html).toContain("Latest eligible");
    expect(html).toContain("Checking only looks for updates");
    expect(html).toContain("Recent activity");
    expect(html).toContain("Updated port");
    expect(html).toContain("Verified source");
    expect(html).toContain("Older activity details are available in a redacted support bundle");
    expect(html).not.toContain("source changed");
    for (const label of [
      "Completed",
      "Failed",
      "Cancelled",
      "Status unavailable",
      "Needs review",
      "In progress",
    ])
      expect(html).toContain(`<span class="activity-status">${label}</span>`);
    expect(html).not.toMatch(/activity-status">(?:succeeded|failed|cancelled|unfinished|running)</);
    expect(html).toContain("No completion recorded");
    expect(html).toContain('<button data-focusable="true">sample-rom</button>');
    expect(html).toContain("Completed, failed, and interrupted work recorded on this device");
  });
});
