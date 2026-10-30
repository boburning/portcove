import desktopPackage from "../../package.json";
import { failureReport, sourceProfile } from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ActivityRecord,
  DoctorReport,
  OperationEvent,
  SourceInspectionReport,
} from "../types";
import { PageHeader, SettingsView, Sidebar, StatusLayer, WorkspaceToolbar } from "./Chrome";
import { applyOperationEvent, mostRecentOperation } from "../features/operations/operation-state";
import { commandShortcut } from "../keyboard-shortcuts";
import { port } from "./rendered-test-fixtures";

describe("desktop components", () => {
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

  it("renders navigation, headers, status, and settings content", () => {
    const html = [
      renderToStaticMarkup(
        <Sidebar
          view="library"
          setView={vi.fn()}
          installedCount={2}
          updateCount={1}
          activities={[]}
        />,
      ),
      renderToStaticMarkup(<WorkspaceToolbar view="catalog" onOpenCommands={vi.fn()} />),
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
    expect(html).not.toContain("Copy existing installation");
    expect(html).toMatch(
      /<button[^>]*data-variant="selected"[^>]*aria-current="page"[^>]*>[^]*?Library[^]*?<\/button>/u,
    );
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*class="[^"]*bg-transparent/u);
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*data-variant="outline"[^>]*aria-label="Search games and pages ${commandShortcut("K")}: open command palette"`,
        "u",
      ),
    );
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*aria-label="Dismiss error"/u);
    expect(html).toContain("Discover");
    expect(html).toMatch(/<span[^>]*>Activity<\/span>/u);
    expect(html).toContain('aria-label="2 in library"');
    expect(html).toContain("Problem");
    expect(html).toContain("C:/Portcove");
    expect(html).toContain("width:50%");
    expect(html).toContain("/brand/icons/portcove-mascot-head-256.png");
    expect(html).toContain("About Portcove");
    expect(html).toContain("Install, update, and play native game ports.");
    expect(html).toContain("/brand/mascot/portcove-mascot-v2-front.png");
    expect(html).toContain(`<h3>Portcove ${desktopPackage.version}</h3>`);
    expect(html).toContain("Licensed under MIT or Apache-2.0.");
    expect(html).toContain("Open project repository");
    expect(html).toContain("Open diagnostics");
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

    expect(library).toContain('<h1 tabindex="-1">Your library</h1>');
    expect(emptyCatalog).toContain("Browse 0 native game ports.");
    expect(onePort).toContain("Browse 1 native game port.");
    expect(catalog).toContain('<h1 tabindex="-1">Discover</h1>');
    expect(catalog).toContain("Browse 61 native game ports.");
    expect(catalog).not.toContain('id="port-search"');
    expect(updates).toContain('<h1 tabindex="-1">Activity</h1>');
    expect(settings).toContain('<h1 tabindex="-1">Settings</h1>');
    for (const header of [library, catalog, updates, settings]) {
      expect(header).not.toContain('class="eyebrow"');
      expect(header).not.toContain('aria-label="Commands ');
    }
    for (const view of ["library", "catalog", "updates", "settings"] as const) {
      const toolbar = renderToStaticMarkup(
        <WorkspaceToolbar view={view} onOpenCommands={vi.fn()} />,
      );
      expect(toolbar).toContain(
        `aria-label="Search games and pages ${commandShortcut("K")}: open command palette"`,
      );
      expect(toolbar).toContain('aria-label="Current location"');
    }
    expect(settings).toContain("App preferences and library settings.");
    for (const header of [library, updates])
      expect(header).not.toContain('class="page-description"');
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
    expect(html).toContain("Saved library");
    expect(html).toContain("Opening another library does not move your files");
    expect(html).toContain("The library you open uses its own game install folder settings");
    expect(html).toContain("Library and storage");
    expect(html).toContain("Entire library");
    expect(html).toContain("Use default library");
    expect(html).toContain("Each game’s install folder is reviewed separately");
    expect(html).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>Choose another library<\/button>/u,
    );
  });

  it("distinguishes a launch override and the default library from a saved choice", () => {
    for (const [source, label] of [
      ["invocation", "This launch only"],
      ["platform_default", "Default library"],
    ] as const) {
      const html = renderToStaticMarkup(
        <SettingsView librarySelection={{ root: "D:/Portcove Library", source }} />,
      );
      expect(html).toContain(label);
      expect(html).not.toContain("Saved library");
    }
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
    expect(html).toContain(
      "Metadata records installed versions, saved file locations and settings",
    );
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Export metadata<\/button>/u);
    expect(html).not.toContain("recovery-safe");
  });

  it("shows the core host-readiness report with explicit tool states", () => {
    const doctor: DoctorReport = {
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
          purpose: "Check CHD game files and prepare disc images",
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
    };
    const html = renderToStaticMarkup(<SettingsView doctor={doctor} />);
    const retained = renderToStaticMarkup(
      <SettingsView
        doctor={doctor}
        diagnosticFailure={new Error("retry failed")}
        refreshDiagnostics={vi.fn()}
      />,
    );
    expect(html).toContain("Disc tools");
    expect(html).toContain('id="disc-tools-heading"');
    expect(html).toContain('data-host-tool-id="chdman"');
    expect(html).toContain("windows-x86-64");
    expect(html).toContain("61 ports · 10 installed · 9 sources");
    expect(html).toContain("Ready");
    expect(html).toContain("Check path");
    expect(html).toContain("Not found");
    expect(html).toContain("C:/Tools/chdman.exe");
    expect(html).toContain("E:/Missing/DolphinTool.exe");
    expect(html).toContain("Future tool was not found. Choose its executable to continue.");
    expect(html).toContain("Environment variable: PORTCOVE_FUTURE_TOOL");
    expect(html).toContain("Tool details");
    expect(html).toContain("Official site");
    expect(html).toContain("Locate Future tool…");
    expect(html).not.toContain("Locate DolphinTool…");
    expect(html).toContain("Recheck");
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Official site<\/button>/u);
    expect(retained).toContain("Couldn’t check disc tools.");
    expect(retained).toContain("Showing the last successful host check.");
    expect(retained).toContain("C:/Tools/chdman.exe");
    expect(retained).toContain("Check disc tools again");
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
    expect(html).toContain("Couldn’t check disc tools.");
    expect(html).toContain("Disc-tool status is unavailable until the check succeeds.");
    expect(html).toContain("Check disc tools again");
    expect(html.match(/<button\b([^>]*)>Check disc tools again<\/button>/)?.[1]).not.toMatch(
      /\sdisabled(?:=""|\s|$)/u,
    );
    expect(html).toContain("Retry diagnostics");
    expect(html).not.toContain("Diagnostics are current");
  });

  it("explains support-bundle and optional disc-tool boundaries", () => {
    const html = renderToStaticMarkup(
      <SettingsView createSupportBundle={vi.fn()} refreshDiagnostics={vi.fn()} />,
    );

    expect(html).toContain("Create support bundle");
    expect(html).toContain("Game-file contents and saved credentials are excluded");
    expect(html).toContain("paths, file names, and other metadata may remain");
    expect(html).toContain("Review the bundle before sharing it");
    expect(html).toContain("Examples of details that may remain");
    expect(html).toMatch(
      /<p>[^<]*Game-file contents and saved credentials are excluded[^<]*paths, file names, and other metadata may remain[^<]*Review the bundle before sharing it\.<\/p>\s*<details>/u,
    );
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
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Color theme"');
    expect(html).toContain("Following system · currently Light");
    const radios = [
      ...html.matchAll(
        /(<span\b[^>]*role="radio"[^>]*>)((?:(?!<span\b[^>]*role="radio")[\s\S])*?)(?=<span\b[^>]*role="radio"|$)/gu,
      ),
    ];
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => /aria-checked="true"/u.test(radio[1] ?? ""))).toHaveLength(1);
    expect(radios.find((radio) => /Follow system<\/span>/u.test(radio[2] ?? ""))?.[1]).toContain(
      'aria-checked="true"',
    );
    expect(radios.find((radio) => /Dark<\/span>/u.test(radio[2] ?? ""))?.[1]).toContain(
      'aria-checked="false"',
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
      const logout = html.match(/<button\b([^>]*)>Sign out<\/button>/);
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
    expect(html).toContain("GitHub connection");
    expect(html).toMatch(/<summary[^>]*>Connection details<\/summary>/u);
    expect(html).toContain("4,998 of 5,000 GitHub requests remaining");
    expect(html).toContain("Operating-system credential store");
    expect(html).not.toContain("Personal access token");
  });

  it("labels the token alternative visibly and handles a connected account without a login name", () => {
    const actions = {
      token: "",
      setToken: vi.fn(),
      saveToken: vi.fn(),
      logout: vi.fn(),
      beginDeviceLogin: vi.fn(),
      refresh: vi.fn(),
    };
    const anonymous = renderToStaticMarkup(
      <SettingsView
        github={{
          ...actions,
          status: {
            source: "anonymous",
            authenticated: false,
            login: null,
            rate_limit: null,
            device_login_available: true,
          },
        }}
      />,
    );
    const connectedWithoutLogin = renderToStaticMarkup(
      <SettingsView
        github={{
          ...actions,
          status: {
            source: "credential_store",
            authenticated: true,
            login: null,
            rate_limit: null,
            device_login_available: true,
          },
        }}
      />,
    );
    expect(anonymous).toContain("Use a token instead");
    expect(anonymous).toMatch(
      /<label[^>]*for="github-personal-access-token"[^>]*>Personal access token<\/label>/u,
    );
    expect(anonymous).toContain('id="github-personal-access-token"');
    const tokenField = anonymous.match(/<input[^>]*id="github-personal-access-token"[^>]*>/)?.[0];
    expect(tokenField).toContain('data-slot="input"');
    expect(tokenField).toContain('type="password"');
    expect(tokenField).toContain('autoComplete="off"');
    expect(anonymous).toContain("Sign in with GitHub");
    expect(connectedWithoutLogin).toContain("Connected to GitHub");
    expect(connectedWithoutLogin).not.toContain("Connected as null");
    expect(connectedWithoutLogin).not.toContain('id="github-personal-access-token"');
  });

  it("does not infer anonymous sign-in while GitHub status is unavailable", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("Connection status unavailable");
    expect(html).toContain("Refresh status to check the GitHub connection.");
    expect(html).not.toContain("Not signed in.");
    expect(html).not.toContain('id="github-personal-access-token"');
    expect(html).toContain("Refresh status");
  });

  it("offers persistent Settings categories with current and controlled-panel semantics", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    const index = html.match(
      /<nav[^>]*aria-label="Settings categories"[^>]*>([\s\S]*?)<\/nav>/u,
    )?.[1];
    expect(index).toBeDefined();
    for (const id of [
      "appearance",
      "library-storage",
      "game-files",
      "updates",
      "integrations",
      "controls",
      "advanced",
      "about",
    ]) {
      expect(html).toContain(`data-settings-group="${id}"`);
      expect(html).toContain(`id="settings-${id}-heading"`);
      expect(index).toContain(`aria-controls="settings-${id}"`);
    }
    expect(index?.match(/data-slot="button"/gu)).toHaveLength(8);
    expect(index?.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(index).toContain("Library and storage");
    expect(index).toContain("Updates");
    expect(index).toContain("Keyboard and controller");
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

    expect(html).toContain("Not signed in. Signing in increases the limit for release checks.");
    expect(html).toContain("GitHub request limit unavailable");
    expect(html).toContain("Continue without signing in or use a personal access token");
    expect(html).toMatch(
      /<label[^>]*for="github-personal-access-token"[^>]*>Personal access token<\/label>/u,
    );
    expect(html).not.toContain("Use a token instead");
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
    expect(verified).toContain("Update file location");
    expect(verified).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>Update file location<\/button>/u,
    );
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
      "This saved file requirement is no longer present in the current catalog.",
    );
    expect(html).toContain("Update the catalog or remove the saved location.");
    expect(html).toContain("Catalog profile ID:");
    expect(html).toContain('class="source-profile-id');
    expect(html).toContain(`>${source.profile_id}</code>`);
    expect(html).toContain(
      `aria-label="Technical details for saved file location ${source.path}, saved reference 1 of 2"`,
    );
    expect(html).toContain(
      `aria-label="Technical details for saved file location ${otherSource.path}, saved reference 2 of 2"`,
    );
    expect(html).not.toContain(`<strong>${source.profile_id}</strong>`);
    expect(html).not.toContain(">Update file location</button>");
    expect(html).toContain("Review saved location removal");
    expect(html).not.toContain("Remove saved location…");
    expect(html).not.toContain('aria-label="Saved-location removal impact"');
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("Checking identity");
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
      requiredBy: [{ portId: port.id, portName: port.name, role: "Game files" as const }],
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
    expect(loading).not.toContain("Required files have been added");
    expect(loading).not.toContain("No ports in your library yet");
    expect(loading).not.toContain("No game files or BIOS files have been added yet");
    expect(loading.match(/<button\b([^>]*)>Find required files<\/button>/)?.[1]).toContain(
      "disabled",
    );
    expect(loading).not.toContain(requirement.profile.label);
    expect(loading).not.toContain(registeredSource.path);
    expect(unavailable).toContain("Required game files could not be checked");
    expect(unavailable).toContain("Retry loading the library before changing saved locations");
    expect(unavailable).not.toContain("Required files have been added");
    expect(unavailable).not.toContain("No ports in your library yet");
    expect(unavailable).not.toContain("No game files or BIOS files have been added yet");
    expect(unavailable.match(/<button\b([^>]*)>Find required files<\/button>/)?.[1]).toContain(
      "disabled",
    );
    expect(unavailable).not.toContain(requirement.profile.label);
    expect(unavailable).not.toContain(registeredSource.path);
    expect(noInstalledPorts).toContain(
      "No ports in your library yet. File requirements will appear here after you add a port.",
    );
    expect(noInstalledPorts).not.toMatch(/class="[^"]*source-requirements[^"]*\bcomplete\b/u);
    expect(complete).toContain("No missing game-file requirements are recorded");
    expect(complete).not.toContain("Required file locations are saved");
    expect(complete).toMatch(/class="[^"]*source-requirements[^"]*\bcomplete\b/u);
    expect(complete).toContain("No game files or BIOS files have been added yet");
    expect(singular).toContain("1 game-file requirement needs attention");
    expect(plural).toContain("2 game-file requirements need attention");
    expect(singular).toContain("Game files and BIOS");
    expect(singular).toContain(
      "File checks run locally without uploading or changing your originals",
    );
    expect(singular).toContain("confirms that the file is an exact match");
    expect(singular).toContain("Sample source set");
    expect(singular).toContain("Sample Port · Game files");
    expect(singular).toContain("Add game files");
    expect(singular).toContain("Add ZIP");
    expect(singular).toMatch(/<button[^>]*data-variant="outline"[^>]*>Add game files<\/button>/u);
    expect(singular).not.toContain("source requirement needs attention");
  });
});
