import { ApplicationUpdateSettings } from "../features/application-update/ApplicationUpdates";
import { ApplicationUpdateNotices } from "../features/application-update/ApplicationUpdateNotices";
import { failureReport, sourceProfile } from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ActivityRecord, PortDefinition } from "../types";
import { SettingsView, Sidebar, StatusLayer } from "./Chrome";
import { DetailPanel } from "./DetailPanel";
import { PortBrowser } from "./PortBrowser";
import { UpdateCenter } from "./UpdateCenter";
import { port, actions, defaultNoticeProps } from "./rendered-test-fixtures";

describe("desktop components", () => {
  it("places feature-owned notices alongside failures and current operation progress", () => {
    const html = renderToStaticMarkup(
      <StatusLayer
        error="Disk unavailable"
        clearError={vi.fn()}
        busy="backup"
        featureNotices={
          <ApplicationUpdateNotices
            {...defaultNoticeProps}
            updateChoiceRequired
            reviewUpdate={vi.fn()}
          />
        }
      />,
    );
    expect(html).toContain("Disk unavailable");
    expect(html).toContain("Portcove updates");
    expect(html).toContain("Backup in progress");
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
        onOpenSettings={vi.fn()}
      />,
    );
    expect(history).toContain("Game-data setup");
    expect(history).toContain("In progress");

    const abandoned = renderToStaticMarkup(
      <Sidebar
        view="catalog"
        setView={vi.fn()}
        installedCount={1}
        updateCount={0}
        activities={[activity({ started_at: now - 24 * 60 * 60 })]}
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
      />,
    );
    expect(failed).toContain('aria-label="Activity needs attention"');
  });

  it("groups Settings capabilities with a separate About destination", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        applicationUpdates={<ApplicationUpdateSettings currentVersion="0.1.0-alpha.2" />}
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
      "controls",
      "advanced",
      "about",
    ]);
    for (const group of groups) {
      expect(html).toContain(
        `data-settings-group="${group}" aria-labelledby="settings-${group}-heading"`,
      );
      expect(html).toContain(`id="settings-${group}-heading"`);
      expect(html).toContain(`id="settings-${group}-heading" tabindex="-1"`);
    }
    const groupMarkup = (group: string) => {
      const start = html.indexOf(`data-settings-group="${group}"`);
      const next = groups[groups.indexOf(group) + 1];
      const end = next ? html.indexOf(`data-settings-group="${next}"`) : html.length;
      return html.slice(start, end);
    };
    expect(groupMarkup("appearance")).toContain("Color theme");
    expect(groupMarkup("library-storage")).toContain("Library at startup");
    expect(groupMarkup("library-storage")).toContain("Files and capacity");
    expect(groupMarkup("game-files")).toContain("Game files and BIOS");
    expect(groupMarkup("game-files")).toContain("Disc tools");
    expect(groupMarkup("updates")).toContain("Portcove updates");
    expect(groupMarkup("updates")).toContain("Portcove &amp; catalog updates");
    expect(groupMarkup("updates")).toContain("Open Updates in Activity for game updates.");
    expect(groupMarkup("updates")).toContain("Game catalog");
    expect(groupMarkup("updates")).not.toContain("Publisher public key");
    expect(groupMarkup("updates")).toContain('class="settings-section-description ');
    expect(groupMarkup("updates")).toContain('class="settings-section-content ');
    expect(groupMarkup("integrations")).toContain("GitHub connection");
    expect(groupMarkup("integrations")).toContain("Steam shortcuts");
    expect(groupMarkup("controls")).toContain("Keyboard shortcuts");
    expect(groupMarkup("controls")).toContain("Controller navigation");
    const advanced = groupMarkup("advanced");
    expect(advanced.indexOf("Create support bundle")).toBeLessThan(
      advanced.indexOf("Original game files stay local"),
    );
    expect(advanced).toContain("Custom catalog sources");
    expect(advanced).not.toContain("About Portcove");
    expect(groupMarkup("about")).toContain("About Portcove");
    expect(html).toContain('aria-label="Settings categories"');
  });

  it("keeps all Settings tasks in ordered full-width rows with their actions and warnings", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        applicationUpdates={<ApplicationUpdateSettings currentVersion="0.1.0-alpha.2" />}
        createSupportBundle={vi.fn()}
        refreshDiagnostics={vi.fn()}
      />,
    );
    const appearance = html.slice(
      html.indexOf('data-settings-group="appearance"'),
      html.indexOf('data-settings-group="library-storage"'),
    );
    const groups = [
      ["appearance", "library-storage", 2],
      ["library-storage", "game-files", 3],
      ["game-files", "updates", 3],
      ["updates", "integrations", 2],
      ["integrations", "controls", 2],
      ["controls", "advanced", 2],
      ["advanced", "about", 3],
      ["about", null, 1],
    ] as const;
    for (const [id, next, rowCount] of groups) {
      const start = html.indexOf(`data-settings-group="${id}"`);
      const end = next ? html.indexOf(`data-settings-group="${next}"`) : html.length;
      const section = html.slice(start, end);
      expect(section).toContain('class="settings-section-content ');
      expect(section.match(/class="settings-row(?: |")/gu)).toHaveLength(rowCount);
      expect(section).not.toContain('class="settings-card');
    }
    const advanced = html.slice(
      html.indexOf('data-settings-group="advanced"'),
      html.indexOf('data-settings-group="about"'),
    );
    expect(appearance.indexOf("Color theme")).toBeLessThan(appearance.indexOf("Language"));
    expect(html.indexOf("Library at startup")).toBeLessThan(html.indexOf("Files and capacity"));
    expect(html.indexOf("Game-file libraries")).toBeLessThan(html.indexOf("Game files and BIOS"));
    expect(html.indexOf("Game files and BIOS")).toBeLessThan(html.indexOf("Disc tools"));
    expect(html.indexOf("Portcove updates")).toBeLessThan(html.indexOf("Game catalog"));
    expect(advanced.indexOf("metadata may remain")).toBeLessThan(
      advanced.indexOf(">Create support bundle</button>"),
    );
    expect(advanced).toContain("Original game files stay local");
    expect(html.slice(html.indexOf('data-settings-group="about"'))).toContain(
      "Open project repository",
    );
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
    expect(details).toContain("Legacy port-wide automated tests");
    expect(details).toContain("Legacy port-wide hands-on tests");
    expect(details).toContain("No legacy platform coverage recorded");
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
        user_prepared: {},
      },
    };
    const html = renderToStaticMarkup(
      <DetailPanel port={retiredPort} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(html).toContain("The upstream project is no longer maintained");
    expect(html).toContain("Portcove checks available releases against its usual source");
    expect(html).toContain("no new upstream fixes are expected");
    expect(html.replace(/ class="[^"]*"/gu, "")).toContain(
      "<small>Catalog designation (not a test result)</small>Stable",
    );
    expect(html.replace(/ class="[^"]*"/gu, "")).toContain(
      "<small>Available release channels</small>Stable",
    );
    expect(html).toContain("Portcove uses the pinned release recorded in the catalog");
    expect(html).not.toContain("no upstream fixes or support");
    expect(html).not.toContain("Portcove checks this project for releases");
    const hosted = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...retiredPort,
          release: { ...port.release, provider: "github" },
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(hosted).toContain("Portcove checks this project for releases");
    expect(hosted).not.toContain("Portcove uses the pinned release recorded in the catalog");
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
    expect(details).toContain("Check game files");
  });
});
