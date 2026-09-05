import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstallRecord, OperationEvent, PortDefinition, PortStatus } from "../types";
import { PageHeader, SettingsView, Sidebar, StatusLayer } from "./Chrome";
import { BackupHistory } from "./BackupHistory";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { PortBrowser } from "./PortBrowser";
import { UpdateCenter } from "./UpdateCenter";
import { AdoptionModal } from "./AdoptionModal";

const port: PortDefinition = {
  id: "sample", name: "Sample Port", summary: "A sample native port", project_url: "https://example.com",
  support_tier: "stable", channels: ["stable", "beta"], platforms: ["windows-x86-64"], adapter: "staged-source-portable",
  automated_tested_platforms: ["windows-x86-64"], manually_validated_platforms: [],
  source_profile: "sample-rom", persistent_paths: ["save"], upstream_status: "active",
  release: {}, executable_hints: {},
};
const actions: DetailActions = {
  activate: vi.fn(), backup: vi.fn(), check: vi.fn(), close: vi.fn(), deleteBackup: vi.fn(), install: vi.fn(), launch: vi.fn(), openUserData: vi.fn(), reviewInstall: vi.fn(), remove: vi.fn(), restoreBackup: vi.fn(), rollback: vi.fn(), setChannel: vi.fn(), setPolicy: vi.fn(), update: vi.fn(), verify: vi.fn(),
};
const installRecord = (overrides: Partial<InstallRecord> = {}): InstallRecord => ({
  id: "1", port_id: port.id, version: "1.0", path: "sample/1.0", channel: "stable", installed_at: 1, verified: true, staged: false,
  artifact: { asset_name: "sample.zip", sha256: "b".repeat(64), size: 1 }, manifest_sha256: "c".repeat(64), selected_executable: "sample.exe",
  ...overrides,
});

describe("desktop components", () => {
  it("labels a new non-streaming task without reusing completed update progress", () => {
    const finished: OperationEvent = { schema_version: 2, operation_id: "old-update", sequence: 4, timestamp_ms: 1,
      operation: "update", type: "finished", message: "Old update completed", completed: 100, total: 100 };
    for (const operation of [undefined, finished]) {
      const html = renderToStaticMarkup(<StatusLayer clearError={vi.fn()} operation={operation} busy="backup" />);
      expect(html).toContain("Backup");
      expect(html).toContain("Working");
      expect(html).not.toContain("Old update");
      expect(html).not.toContain("width:100%");
    }
  });

  it("routes a missing verified runtime to reviewed installation instead of Play", () => {
    const html = renderToStaticMarkup(<DetailPanel port={{ ...port, source_profile: undefined }} sourcePath="" setSourcePath={vi.fn()} actions={actions}
      status={{ port_id: port.id, channel: "stable", update_policy: "notify", active: installRecord(), readiness: { launchable: false, blockers: ["missing_runtime"], pending_setup: false } }} />);
    expect(html).toContain("Verified runtime required");
    expect(html).toContain("Review install");
    expect(html).not.toContain("Play now");
    expect(html).not.toContain("Choose required source");
  });

  it("shows changed registered bytes as setup instead of launch readiness", () => {
    const source = { profile_id: "sample-rom", path: "source.z64", sha256: "a".repeat(64), size: 12, storage_sha256: "a".repeat(64), storage_size: 12, updated_at: 1 };
    const html = renderToStaticMarkup(<DetailPanel port={port} source={source} sourcePath="source.z64" setSourcePath={vi.fn()} actions={actions}
      status={{ port_id: port.id, channel: "stable", update_policy: "notify", active: installRecord(), readiness: { launchable: false, blockers: ["changed_source"], pending_setup: false, source: "changed" } }} />);
    expect(html).toContain("Original source changed");
    expect(html).toContain("Registered source changed since it was added");
    expect(html).toContain("Choose required source");
    expect(html).not.toContain("Play now");
  });
  it("shows the reviewed adoption copy plan and skipped entries before copying", () => {
    const html = renderToStaticMarkup(<AdoptionModal
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
          files: [{ relative_path: "sample.exe", size: 2048, sha256: "a".repeat(64) }],
          skipped_entries: [{ relative_path: "linked-save", reason: "symbolic links are not copied" }],
          total_bytes: 2048,
        },
        plan_sha256: "b".repeat(64),
      }}
    />);
    expect(html).toContain("1 file · 2.0 KiB");
    expect(html).toContain("1 skipped entry");
    expect(html).toContain("linked-save");
    expect(html).toContain("Copy into Portcove");
  });

  it("keeps older backups reachable without expanding the detail panel by default", () => {
    const backups = Array.from({ length: 4 }, (_, index) => ({
      id: `backup-${index}`, port_id: port.id, path: `backups/sample/${index}`,
      created_at: index + 1, file_count: 2, size: 1024, sha256: `${index}`.repeat(64),
    }));
    const html = renderToStaticMarkup(<BackupHistory backups={backups} restore={vi.fn()} remove={vi.fn()} />);
    expect(html).toContain("4 verified snapshots");
    expect(html).toContain("Show 1 older");
    expect(html).not.toContain("3333333333");
  });

  it("keeps verified backups usable while exposing degraded and recovery details", () => {
    const backups = [{
      id: "backup-1", port_id: port.id, path: "backups/sample/backup-1",
      created_at: 1, file_count: 2, size: 1024, sha256: "a".repeat(64),
    }];
    const html = renderToStaticMarkup(<BackupHistory backups={backups} state="recovery_required" problems={[{
      kind: "recovery_required", operation_id: "operation-1", path: "backups/sample/.deleting-operation-1",
      message: "Deletion was interrupted.", proposed_action: "Restart Portcove, then review doctor output.",
    }]} restore={vi.fn()} remove={vi.fn()} />);
    expect(html).toContain("Backup recovery required");
    expect(html).toContain("1 verified snapshot");
    expect(html).toContain("Technical details");
    expect(html).toContain("Deletion was interrupted");
    expect(html).toContain("Restore");
  });

  it("renders navigation, headers, status, and settings content", () => {
    const html = [
      renderToStaticMarkup(<Sidebar view="library" setView={vi.fn()} installedCount={2} updateCount={1} onAdopt={vi.fn()} />),
      renderToStaticMarkup(<PageHeader view="catalog" query="sample" setQuery={vi.fn()} />),
      renderToStaticMarkup(<StatusLayer error="Problem" clearError={vi.fn()} operation={{ schema_version: 2, operation_id: "install-1", sequence: 1, timestamp_ms: 1, operation: "install", type: "progress", phase: "install", completed: 1, total: 2 }} busy="install" />),
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
    const html = renderToStaticMarkup(<SettingsView
      librarySelection={{ root: "D:/Portcove Library", source: "saved" }}
      chooseLibrary={vi.fn()}
      resetLibrary={vi.fn()}
    />);
    expect(html).toContain("D:/Portcove Library");
    expect(html).toContain("Saved host preference");
    expect(html).toContain("it does not move files");
    expect(html).toContain("Use platform default");
  });

  it("shows the shared library path and volume capacity", () => {
    const html = renderToStaticMarkup(<SettingsView storage={{
      library_root: "E:/Portcove", volume_total_bytes: 1024 ** 4, volume_available_bytes: 512 * 1024 ** 3,
    }} />);
    expect(html).toContain("E:/Portcove");
    expect(html).toContain("512 GiB available");
    expect(html).toContain("1.0 TiB volume");
    expect(html).toContain("aria-label=\"Available library storage\"");
    expect(html).toContain("width:50%");
  });

  it("shows the core host-readiness report with explicit tool states", () => {
    const html = renderToStaticMarkup(<SettingsView doctor={{
      platform: "windows-x86-64",
      library: { library_root: "E:/Portcove", volume_total_bytes: 1024, volume_available_bytes: 512 },
      catalog_port_count: 61,
      catalog_provenance: { origin: "embedded", catalog_sha256: "a".repeat(64), sequence: null, key_id: null, expires_at: null, fallback_reasons: [] },
      installed_port_count: 10,
      registered_source_count: 9,
      repair: { generated_at: 1, items: [] },
      host_tools: [{
        id: "chdman", state: "available", path: "C:/Tools/chdman.exe", source: "discovery",
        configuration_variable: "PORTCOVE_CHDMAN", purpose: "CHD validation and disc-image materialization",
      }, {
        id: "dolphin_tool", state: "misconfigured", path: "E:/Missing/DolphinTool.exe", source: "environment",
        configuration_variable: "PORTCOVE_DOLPHIN_TOOL", purpose: "compressed GameCube validation and ISO materialization",
      }, {
        id: "future_tool", state: "missing", configuration_variable: "PORTCOVE_FUTURE_TOOL", purpose: "future source conversion",
      }],
    }} />);
    expect(html).toContain("Source tools");
    expect(html).toContain("windows-x86-64");
    expect(html).toContain("61 ports · 10 installed · 9 sources");
    expect(html).toContain("Ready");
    expect(html).toContain("Check path");
    expect(html).toContain("Not found");
    expect(html).toContain("C:/Tools/chdman.exe");
    expect(html).toContain("E:/Missing/DolphinTool.exe");
    expect(html).toContain("Set PORTCOVE_FUTURE_TOOL");
  });

  it("renders an accessible system, dark, and light appearance choice", () => {
    const html = renderToStaticMarkup(<SettingsView appearance={{
      preference: "system", resolvedTheme: "light", setPreference: vi.fn(),
    }} />);
    expect(html).toContain("APPEARANCE");
    expect(html).toContain("aria-label=\"Color theme\"");
    expect(html).toContain("aria-pressed=\"true\">System</button>");
    expect(html).toContain("aria-pressed=\"false\">Dark</button>");
    expect(html).toContain("aria-pressed=\"false\">Light</button>");
    expect(html).toContain("Following system · currently Light");
  });

  it("keeps recovery controls available for rejected saved sign-ins and explains environment overrides", () => {
    for (const source of ["credential_store", "environment"] as const) {
      const html = renderToStaticMarkup(<SettingsView github={{
        status: { source, authenticated: false, device_login_available: true },
        token: "", setToken: vi.fn(), saveToken: vi.fn(), logout: vi.fn(), beginDeviceLogin: vi.fn(), refresh: vi.fn(),
      }} />);
      if (source === "credential_store") {
        expect(html).toContain("GitHub no longer accepts the saved sign-in");
        const signIn = html.match(/<button\b([^>]*)>Sign in with GitHub<\/button>/);
        const logout = html.match(/<button\b([^>]*)>Log out<\/button>/);
        expect(signIn).not.toBeNull();
        expect(logout).not.toBeNull();
        expect(signIn?.[1]).not.toContain("disabled");
        expect(logout?.[1]).not.toContain("disabled");
      } else {
        expect(html).toContain("Replace or remove it outside Portcove");
        expect(html).not.toContain("Sign in with GitHub");
        expect(html).not.toContain('type="password"');
      }
    }
  });

  it("shows GitHub authentication source and rate allowance without exposing a token", () => {
    const html = renderToStaticMarkup(<SettingsView libraryRoot="C:/Portcove" github={{
      status: { source: "credential_store", authenticated: true, login: "port-user", rate_limit: { limit: 5000, remaining: 4998, resets_at: 1 }, device_login_available: true },
      token: "", setToken: vi.fn(), saveToken: vi.fn(), logout: vi.fn(), beginDeviceLogin: vi.fn(), refresh: vi.fn(),
    }} />);
    expect(html).toContain("Connected as port-user");
    expect(html).toContain("4,998 of 5,000");
    expect(html).toContain("Operating-system credential store");
    expect(html).not.toContain("Personal access token");
  });

  it("shows read-only source integrity outcomes", () => {
    const source = { profile_id: "sample-rom", path: "D:/ROMs/sample.z64", sha256: "a".repeat(64), size: 1024, storage_sha256: "a".repeat(64), storage_size: 1024, updated_at: 1 };
    const verified = renderToStaticMarkup(<SettingsView libraryRoot="C:/Portcove" sources={[source]} sourceOutcomes={[{
      profile_id: source.profile_id, ok: true, result: { ...source, registered_at: 1, verified_at: 2 },
    }]} verifySources={vi.fn()} replaceSource={vi.fn()} />);
    const failed = renderToStaticMarkup(<SettingsView libraryRoot="C:/Portcove" sources={[source]} sourceOutcomes={[{
      profile_id: source.profile_id, ok: false, error: { code: "source_invalid", message: "source changed since registration", details: {} },
    }]} verifySources={vi.fn()} />);
    expect(verified).toContain("Verified");
    expect(verified).toContain("D:/ROMs/sample.z64");
    expect(verified).toContain("Relink source");
    expect(failed).toContain("Needs attention");
    expect(failed).toContain("source changed since registration");
  });

  it("surfaces missing installed-library source requirements in settings", () => {
    const html = renderToStaticMarkup(<SettingsView libraryRoot="C:/Portcove" sourceNeeds={[{
      profile: { id: "sample-set", label: "Sample source set", kind: "file-set", accepted_extensions: [] },
      requiredBy: [{ portId: port.id, portName: port.name, role: "Game source" }],
    }]} addSource={vi.fn()} />);
    expect(html).toContain("1 source requirement needs attention");
    expect(html).toContain("Sample source set");
    expect(html).toContain("Sample Port · Game source");
    expect(html).toContain("Add source");
    expect(html).toContain("Add ZIP");
  });

  it.each([undefined, installRecord(), installRecord({ verified: false })])("does not infer blanket assurances from an install record", active => {
    const html = renderToStaticMarkup(<DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} actions={actions}
      status={{ port_id: port.id, channel: "stable", update_policy: "notify", active }} />);
    expect(html).not.toContain("Verified releases");
    expect(html).not.toContain("Rollback retained");
    expect(html).not.toContain("Saves protected");
    expect(html).not.toContain("Previous version recorded");
  });

  it("reports a recorded previous version without promising rollback or save compatibility", () => {
    const html = renderToStaticMarkup(<DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} actions={actions}
      status={{ port_id: port.id, channel: "stable", update_policy: "notify", active: installRecord(), previous: installRecord({ version: "0.9" }) }} />);
    expect(html).toContain("Previous version recorded · 0.9");
    expect(html).not.toContain("Rollback retained");
    expect(html).not.toContain("Saves protected");
  });

  it("keeps an unchecked selected path eligible for install review without calling it checked", () => {
    const html = renderToStaticMarkup(<DetailPanel port={port} sourcePath="selected.z64" setSourcePath={vi.fn()} actions={actions} />);
    expect(html).toContain("Selected game files have not been checked");
    expect(html).toContain("Selected path has not been checked");
    const review = html.match(/<button[^>]*>[^]*?Review install<\/button>/g)?.at(-1)?.split("<button").at(-1);
    expect(review).toBeDefined();
    expect(review).not.toContain("disabled");
    expect(html).not.toContain("Ready to launch");
  });

  it("does not turn a selected override into registered-source readiness", () => {
    const source = { profile_id: "sample-rom", path: "registered.z64", sha256: "a".repeat(64), size: 12, storage_sha256: "a".repeat(64), storage_size: 12, updated_at: 1 };
    const html = renderToStaticMarkup(<DetailPanel port={port} source={source} sourcePath="new.z64" setSourcePath={vi.fn()} actions={actions}
      status={{ port_id: port.id, channel: "stable", update_policy: "notify", active: installRecord(), readiness: { source: "current", launchable: true, blockers: [], pending_setup: false } }} />);
    expect(html).toContain("Game files need checking");
    expect(html).toContain("Selected path has not been checked");
    expect(html).not.toContain("Current registered bytes checked");
    expect(html).not.toContain("Ready to launch");
    expect(html).toContain("Play now");
  });

  it("renders installed and uninstalled detail actions", () => {
    const uninstalled = renderToStaticMarkup(<DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} pickSource={vi.fn()} actions={actions} />);
    const sourceFree = renderToStaticMarkup(<DetailPanel port={{ ...port, source_profile: undefined }} sourcePath="" setSourcePath={vi.fn()} actions={actions} />);
    const status: PortStatus = { port_id: port.id, user_data_root: "C:/Portcove/user/sample", channel: "stable", update_policy: "notify", active: installRecord() };
    const installed = renderToStaticMarkup(<DetailPanel port={port} status={status} sourcePath="source.z64" setSourcePath={vi.fn()} actions={actions} backups={[{
      id: "backup-1", port_id: port.id, path: "backups/sample/backup-1", created_at: 1,
      file_count: 2, size: 1024, sha256: "a".repeat(64),
    }]} />);
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
    expect(installed).toContain("Persistent data root");
    expect(installed).toContain("C:/Portcove/user/sample");
    expect(installed).toContain("Deferred / not completed");
    expect(installed).toContain("Launch command");
    expect(installed).toContain("portcove exec sample --");
    expect(installed).toContain("Open upstream project");
  });

  it("summarizes a resolved install before starting the download", () => {
    const html = renderToStaticMarkup(<DetailPanel port={{ ...port, source_profile: undefined }} sourcePath="" setSourcePath={vi.fn()} actions={actions} installPlan={{
      port_id: port.id, channel: "stable", platform: "windows-x86-64", action: "download", source_requirements: [], download_bytes: 64 * 1024 ** 2,
      release: { version: "2.0", channel: "stable", asset: { name: "sample.zip", url: "https://example.com/sample.zip", size: 64 * 1024 ** 2, sha256: "a".repeat(64) } },
      storage: { library_root: "E:/Portcove", volume_total_bytes: 1024 ** 4, volume_available_bytes: 512 * 1024 ** 3 },
    }} />);
    expect(html).toContain("INSTALL PLAN");
    expect(html).toContain("2.0");
    expect(html).toContain("64.0 MiB");
    expect(html).toContain("512 GiB available");
    expect(html).toContain("Install · 64.0 MiB");
  });

  it("explains the folder contract for a multi-disc source", () => {
    const html = renderToStaticMarkup(<DetailPanel port={port} sourceProfile={{
      id: "sample-rom", label: "Three-disc set", kind: "psx-disc", accepted_extensions: ["chd"],
      disc: { track_counts: [1], discs: [
        { label: "Disc 1", track_counts: [1] },
        { label: "Disc 2", track_counts: [1] },
        { label: "Disc 3", track_counts: [1] },
      ] },
    }} sourcePath="" setSourcePath={vi.fn()} pickSource={vi.fn()} actions={actions} />);
    expect(html).toContain("Three-disc set");
    expect(html).toContain("folder containing the required sources");
    expect(html).toContain("exactly the required source set");
  });

  it("renders an independently selectable required BIOS", () => {
    const html = renderToStaticMarkup(<DetailPanel port={{ ...port, bios_source_profile: "psx-bios" }}
      sourcePath="game.chd" setSourcePath={vi.fn()} biosPath="scph1001.bin" setBiosPath={vi.fn()} pickBios={vi.fn()}
      biosProfile={{ id: "psx-bios", label: "PlayStation SCPH-1001 BIOS", accepted_extensions: ["bin"] }} actions={actions} />);
    expect(html).toContain("Required BIOS");
    expect(html).toContain("PlayStation SCPH-1001 BIOS");
    expect(html).toContain("scph1001.bin");
  });

  it("offers activation when an update is staged", () => {
    const install = installRecord();
    const status: PortStatus = { port_id: port.id, channel: "stable", update_policy: "stage", active: install, staged: { ...install, id: "2", version: "2.0", staged: true } };
    const html = renderToStaticMarkup(<DetailPanel port={port} status={status} sourcePath="" setSourcePath={vi.fn()} actions={actions} />);
    expect(html).toContain("Activate staged");
  });

  it("renders port cards and empty states", () => {
    const overview = { installed: 0, ready: 0, needsSetup: 0, staged: 0 };
    const cards = renderToStaticMarkup(<PortBrowser view="catalog" ports={[port]} statuses={new Map()} registeredSources={new Set()} overview={overview} filter="all" setFilter={vi.fn()} onSelect={vi.fn()} loading={false} />);
    const empty = renderToStaticMarkup(<PortBrowser view="catalog" ports={[]} statuses={new Map()} registeredSources={new Set()} overview={overview} filter="all" setFilter={vi.fn()} onSelect={vi.fn()} loading={false} />);
    const emptyLibrary = renderToStaticMarkup(<PortBrowser view="library" ports={[]} statuses={new Map()} registeredSources={new Set()} overview={overview} filter="all" setFilter={vi.fn()} onSelect={vi.fn()} loading={false} />);
    const loading = renderToStaticMarkup(<PortBrowser view="library" ports={[]} statuses={new Map()} registeredSources={new Set()} overview={overview} filter="all" setFilter={vi.fn()} onSelect={vi.fn()} loading />);
    expect(cards).toContain("Sample Port");
    expect(cards).toContain("Available");
    expect(empty).toContain("No ports match these filters");
    expect(empty).toContain("Clear search and filters");
    expect(emptyLibrary).toContain("/brand/mascot/portcove-mascot-v2-front.png");
    expect(emptyLibrary).toContain("aria-hidden=\"true\"");
    expect(loading).toContain("/brand/logo/portcove-logo-v2-transparent.png");
    expect(loading).toContain("alt=\"Portcove\"");
  });

  it("summarizes an installed library around play readiness", () => {
    const install = installRecord();
    const status: PortStatus = {
      port_id: port.id, channel: "stable", update_policy: "notify", active: install,
      last_update_check: {
        checked_at: 2,
        check: {
          port_id: port.id, channel: "stable", installed_version: "1.0", installed_artifact: install.artifact, update_available: true,
          release: { version: "2.0", channel: "stable", asset: { name: "sample.zip", url: "https://example.com/sample.zip", size: 1, sha256: "a".repeat(64) } },
        },
      },
    };
    const html = renderToStaticMarkup(<PortBrowser view="library" ports={[port]} statuses={new Map([[port.id, status]])} registeredSources={new Set(["sample-rom"])}
      overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }} filter="ready" setFilter={vi.fn()} onSelect={vi.fn()} loading={false} />);
    expect(html).toContain("Launch ready");
    expect(html).toContain("Update available");
    expect(html).toContain("Sources stay local");
  });

  it("offers Continue only from a recorded successful launch", () => {
    const install = installRecord();
    const recentStatus: PortStatus = { port_id: port.id, channel: "stable", update_policy: "notify", active: install, last_launched_at: 100, successful_launches: 1 };
    const html = renderToStaticMarkup(<PortBrowser view="library" ports={[port]} statuses={new Map([[port.id, recentStatus]])} registeredSources={new Set(["sample-rom"])}
      overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }} recent={{ port, status: recentStatus }} filter="all" setFilter={() => undefined} onSelect={() => undefined} onContinue={() => undefined} loading={false} />);
    expect(html).toContain("CONTINUE");
    expect(html).toContain("Play again");
    expect(html).toContain("Last successful session");
  });

  it("routes Continue to setup when previously launched source bytes changed", () => {
    const install = installRecord();
    const recentStatus: PortStatus = {
      port_id: port.id, channel: "stable", update_policy: "notify", active: install, last_launched_at: 100, successful_launches: 1,
      readiness: { launchable: false, blockers: ["changed_source"], pending_setup: false, source: "changed" },
    };
    const html = renderToStaticMarkup(<PortBrowser view="library" ports={[port]} statuses={new Map([[port.id, recentStatus]])} registeredSources={new Set(["sample-rom"])}
      overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }} recent={{ port, status: recentStatus }} filter="all" setFilter={() => undefined} onSelect={() => undefined} onContinue={() => undefined} loading={false} />);
    expect(html).toContain("Finish setup");
    expect(html).not.toContain("Play again");
  });

  it("summarizes update checks and exposes policy reconciliation", () => {
    const install = installRecord();
    const status: PortStatus = { port_id: port.id, channel: "stable", update_policy: "notify", active: install };
    const html = renderToStaticMarkup(<UpdateCenter ports={[port]} statuses={new Map([[port.id, status]])} activities={[{
      id: "activity-1", operation: "update", target_kind: "port", target_id: port.id, status: "succeeded", started_at: 1, finished_at: 2,
    }, {
      id: "activity-2", operation: "verify_source", target_kind: "source", target_id: "sample-rom", status: "failed", message: "source changed", started_at: 3, finished_at: 4,
    }, {
      id: "activity-3", operation: "install", target_kind: "port", target_id: port.id, status: "running", started_at: 1,
    }]} actions={new Map()} busy={undefined}
      checkAll={vi.fn()} applyPolicies={vi.fn()} onSelect={vi.fn()} onOpenSources={vi.fn()} outcomes={[{ port_id: port.id, ok: true, result: {
        port_id: port.id, channel: "stable", installed_version: "1.0", update_available: true,
        release: { version: "2.0", channel: "stable", asset: { name: "sample.zip", url: "https://example.com/sample.zip", size: 1, sha256: "a".repeat(64) } },
      } }]} />);
    expect(html).toContain("Available");
    expect(html).toContain("2.0");
    expect(html).toContain("Apply update policies");
    expect(html).toContain("Recent activity");
    expect(html).toContain("Updated port");
    expect(html).toContain("Verified source");
    expect(html).toContain("source changed");
    expect(html).toContain("unfinished");
    expect(html).toContain("No completion recorded");
    expect(html).toContain("<button data-focusable=\"true\">sample-rom</button>");
    expect(html).toContain("CLI and desktop operations use the same local history");
  });
});
