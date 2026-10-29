import {
  fixtureValue,
  portStatus,
  sourceProfile,
  confirmedSourceAssessment,
} from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { InstallRecord, PortDefinition, PortStatus, SourceInspectionReport } from "../types";
import { DetailPanel, InstallationVersionSummary } from "./DetailPanel";
import { currentCatalogPort } from "../catalog-test-fixtures";
import {
  port,
  actions,
  installRecord,
  bundledRuntime,
  runtimeIdentity,
} from "./rendered-test-fixtures";

function detailSection(
  html: string,
  section: "overview" | "files" | "saves" | "versions" | "manage",
) {
  const sections = ["overview", "files", "saves", "versions", "manage"];
  const start = html.indexOf(`id="detail-section-${section}"`);
  expect(start, `${section} panel heading is present`).toBeGreaterThan(-1);
  const next = sections[sections.indexOf(section) + 1];
  return html.slice(start, next ? html.indexOf(`id="detail-section-${next}"`) : undefined);
}

it.each([false, true])(
  "retains the portable game's own setup guide without Core file pickers (installed %s)",
  (installed) => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          adapter: "native-portable",
          source_profile: null,
          bios_source_profile: null,
          presentation: {
            installation_method: "portable-package",
            source_requirements: [],
            saves_and_settings: "external-user-owned",
            manual_setup: {
              steps: [
                {
                  title: "Choose your original game",
                  instruction: "The game asks for your own original files on first Play.",
                },
              ],
              warnings: [],
            },
          },
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{ ...portStatus(), active: installed ? installRecord() : null }}
      />,
    );
    const files = detailSection(html, "files");
    expect(files).toContain("Choose your original game");
    expect(files).toContain("The game asks for your own original files on first Play.");
    expect(files).not.toContain('id="source-');
  },
);

const preparedPort: PortDefinition = {
  ...port,
  source_profile: null,
  release: { ...port.release, provider: "user-prepared" },
  presentation: {
    installation_method: "user-prepared-runtime",
    source_requirements: [],
    saves_and_settings: "external-user-owned",
  },
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
  sha256: fixtureValue(mortalKombat4Profile.accepted_sha256[0], "reviewed MK4 digest"),
  size: 1,
  storage_sha256: fixtureValue(mortalKombat4Profile.accepted_sha256[0], "reviewed MK4 digest"),
  storage_size: 1,
  updated_at: 1,
};
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

it("distinguishes catalog saved-data declarations, retained installation rules and external saves", () => {
  const coverage = (
    currentPort: PortDefinition,
    active: InstallRecord | null,
    externalRuntime?: PortStatus["external_runtime"],
  ) => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={currentPort}
        status={{
          ...portStatus(),
          active,
          ...(externalRuntime ? { external_runtime: externalRuntime } : {}),
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    return (
      html.match(/<section aria-label="Saved-data coverage">([\s\S]*?)<\/section>/u)?.[1] ?? ""
    );
  };
  const catalog = coverage(port, null);
  expect(catalog).toContain("Current catalog saved-data declarations");
  expect(catalog).toContain("<code>save</code>");
  expect(catalog).toContain("when creating a backup");
  expect(catalog).toContain("Other locations are not covered");
  const managed = coverage(
    { ...port, persistent_paths: ["changed-provider-catalog-path"] },
    installRecord(),
  );
  expect(managed).toContain("rules recorded for this installation");
  expect(managed).toContain("Exact paths are not available");
  expect(managed).not.toContain("changed-provider-catalog-path");
  expect(managed).not.toContain("backup review");
  const retained = coverage(
    { ...preparedPort, persistent_paths: ["new-catalog-path"] },
    installRecord(),
  );
  expect(retained).toContain("rules recorded for this installation");
  expect(retained).toContain("Exact paths are not available");
  expect(retained).not.toContain("new-catalog-path");
  const external = coverage(preparedPort, null, {
    id: "external",
    port_id: preparedPort.id,
    path: "fixture/external",
    executable: "fixture/external/game.exe",
    version: "1.0",
    platform: "windows-x86-64",
    archive_sha256: "a".repeat(64),
    immutable_tree_sha256: "b".repeat(64),
    registered_at: 1,
  });
  expect(external).toContain("outside Portcove’s managed backups");
  expect(external).not.toContain("<code>save</code>");
});

it.each([
  ["allowed", "available", false, null],
  [
    "held",
    "invalid_installation",
    true,
    "Portcove could not verify the previous version. Restore previous version is on hold.",
  ],
  [
    "held",
    "missing_runtime",
    true,
    "The previous version needs its verified runtime before it can be restored.",
  ],
] as const)("renders retained rollback action %s/%s", (availability, reason, disabled, message) => {
  const html = renderToStaticMarkup(
    <DetailPanel
      port={port}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
      status={{
        ...portStatus(),
        port_id: port.id,
        active: installRecord(),
        previous: installRecord({ id: "previous", version: "0.9" }),
        port_actions: [{ action: "rollback", availability, reason }],
      }}
    />,
  );
  const button = [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].find(
    ([, content]) =>
      fixtureValue(content, "button HTML capture")
        .replaceAll(/<[^>]+>/g, "")
        .trim() === "Restore previous version",
  )?.[0];
  expect(button).toBeDefined();
  expect(button?.includes('disabled=""')).toBe(disabled);
  expect(html.includes("data-rollback-assessment")).toBe(disabled);
  const assessment = html.match(/<p\b[^>]*data-rollback-assessment[^>]*>(.*?)<\/p>/s)?.[1] ?? null;
  expect(assessment).toBe(message);
});

describe("desktop components", () => {
  it.each(["unknown", "available", "none", "stale-channel"] as const)(
    "keeps the %s update observation and action eligibility under a header check",
    (state) => {
      const fixture = missingRuntimeFixture(state === "available");
      const status: PortStatus = {
        ...fixture.status,
        last_update_check: state === "unknown" ? null : fixture.status.last_update_check,
        channel: state === "stale-channel" ? "beta" : "stable",
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
      const check = html.indexOf("Check for updates</button>");
      const review = html.indexOf("Update now");
      expect(check).toBeGreaterThan(-1);
      expect(review >= 0).toBe(state === "available");
      expect(review === -1 || check < review).toBe(true);
      const expected =
        state === "available"
          ? "was available at the last check"
          : state === "none"
            ? "No update was found at the last check"
            : "No update check is saved for this installation and channel";
      expect(html).toContain(expected);
      expect(state !== "available" || html.indexOf(expected) < review).toBe(true);
      expect(html).not.toContain(">This update<");
      expect(html.indexOf("Future update preferences")).toBeGreaterThan(Math.max(check, review));
    },
  );
  it("keeps a valid ZIP source distinct from the retained external runtime's required launch format", () => {
    const runtimePort = currentCatalogPort("wave-race-64-recomp");
    const source = {
      profile_id: "wave-race-64",
      path: "player-owned.zip",
      sha256: "a".repeat(64),
      size: 12,
      storage_sha256: "b".repeat(64),
      storage_size: 24,
      updated_at: 1,
    };
    const status: PortStatus = {
      ...portStatus(),
      port_id: runtimePort.id,
      external_runtime: {
        id: "external-format",
        port_id: runtimePort.id,
        path: "C:/Player/Runtime",
        executable: "C:/Player/Runtime/WaveRace64Recomp.exe",
        version: "v1.0.2",
        platform: "windows-x86-64",
        archive_sha256: "c".repeat(64),
        immutable_tree_sha256: "d".repeat(64),
        registered_at: 1,
      },
      readiness: {
        launchable: false,
        pending_setup: false,
        source: "current",
        source_assessment: confirmedSourceAssessment(),
        required_source_extension: "z64",
        blockers: ["incompatible_source"],
      },
      port_actions: [{ action: "launch", availability: "waiting", reason: "incompatible_source" }],
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={runtimePort}
        source={source}
        sourcePath={source.path}
        setSourcePath={vi.fn()}
        pickSource={vi.fn()}
        actions={actions}
        status={status}
      />,
    );
    expect(html).toContain("This runtime requires an uncompressed .z64 game file.");
    expect(html).toContain("Select and validate that file before playing.");
    expect(html).toContain("Files are unchanged since they were added");
    expect(html).not.toContain("Launch availability is unavailable");
    expect(html).not.toContain("Ready to play");
    expect(status.readiness?.source).toBe("current");
  });

  it("describes player-prepared registration before and after it joins the library", () => {
    const props = {
      port: preparedPort,
      sourcePath: "",
      setSourcePath: vi.fn(),
      actions,
    };
    const available = renderToStaticMarkup(<DetailPanel {...props} />);
    expect(available).toContain("Prepare your runtime");
    expect(available).toContain("without installing or owning them");
    expect(available).toContain("You prepare the runtime");
    expect(available).not.toContain("Available to install");
    expect(available).not.toContain("Portcove checks this project for releases");

    const registered = renderToStaticMarkup(
      <DetailPanel
        {...props}
        status={{
          ...portStatus(),
          external_runtime: {
            id: "prepared-1",
            port_id: preparedPort.id,
            path: "C:\\Player\\Runtime",
            executable: "C:\\Player\\Runtime\\game.exe",
            version: "1.0.2",
            platform: "windows-x86-64",
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            registered_at: 1,
          },
          readiness: { launchable: true, blockers: [], pending_setup: false },
        }}
      />,
    );
    expect(registered).toContain("Ready to play");
    expect(registered).toContain("It does not copy, update, back up, or delete these files");
  });

  it("describes user-selected setup without accepted-package or unsupported repair promises", () => {
    const selectedPort = currentCatalogPort("render96ex");
    const props = { port: selectedPort, sourcePath: "", setSourcePath: vi.fn(), actions };
    const available = renderToStaticMarkup(<DetailPanel {...props} />);
    expect(available).toContain("Choose your existing installation");
    expect(available).toContain("Your existing installation");
    expect(available).not.toContain("uses the accepted package identity");
    expect(available).not.toContain("Choose the accepted external folder");
    expect(available).not.toContain("Archive SHA-256");
    const unavailable = renderToStaticMarkup(
      <DetailPanel
        {...props}
        status={{
          ...portStatus(),
          port_id: selectedPort.id,
          external_runtime: {
            id: "selected-registration",
            port_id: selectedPort.id,
            path: "C:/Owned game",
            executable: "C:/Owned game/game.exe",
            version: "user-managed",
            platform: "windows-x86-64",
            archive_sha256: "",
            immutable_tree_sha256: "",
            registered_at: 1,
            user_selected: { arguments: [] },
          },
          readiness: {
            launchable: false,
            pending_setup: false,
            blockers: ["invalid_installation"],
            source: null,
            bios: null,
          },
        }}
      />,
    );
    expect(unavailable).toContain("Existing installation unavailable");
    expect(unavailable).toContain("Edit launch details");
    expect(unavailable).not.toContain("Choose Check installed files");
  });

  it.each([false, true])(
    "preserves retained managed actions after the current route changes (invalid: %s)",
    (invalid) => {
      const currentPort = currentCatalogPort("render96ex");
      const status: PortStatus = {
        ...portStatus(),
        port_id: currentPort.id,
        active: installRecord({ port_id: currentPort.id }),
        readiness: {
          launchable: !invalid,
          pending_setup: false,
          blockers: invalid ? ["invalid_installation"] : [],
          source: null,
          bios: null,
        },
        port_actions: [
          {
            action: "launch",
            availability: invalid ? "held" : "allowed",
            reason: invalid ? "invalid_installation" : "available",
          },
          { action: "update", availability: "not_offered", reason: "route_not_offered" },
          { action: "remove_managed", availability: "waiting", reason: "review_required" },
        ],
      };
      const html = renderToStaticMarkup(
        <DetailPanel
          port={currentPort}
          status={status}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
        />,
      );
      expect(html).toContain("Check installed files");
      expect(html).toContain(`Uninstall ${currentPort.name}`);
      expect(html).toContain("Managed by Portcove using this installation");
      expect(html).toContain("Saved data follows this installation");
      expect(html).not.toContain("No saved data paths declared");
      expect(html).not.toContain("Game-owned settings and saves in the external runtime");
      expect(html).not.toContain("Choose game executable");
      expect(html).not.toContain("Remove registration");
      expect(html).not.toContain("remove only this registration");
      expect(html).not.toContain("Check for updates</button>");
      expect(html).toContain(invalid ? "Installation needs repair" : "data-launch-action");
    },
  );
  it.each([undefined, "activate"])(
    "preserves retained staged activation after the current route changes (busy: %s)",
    (busy) => {
      const currentPort = currentCatalogPort("render96ex");
      const status: PortStatus = {
        ...portStatus(),
        port_id: currentPort.id,
        active: null,
        staged: installRecord({ port_id: currentPort.id, version: "retained-staged" }),
        readiness: {
          launchable: false,
          pending_setup: false,
          blockers: [],
          source: null,
          bios: null,
        },
        port_actions: [
          { action: "install", availability: "not_offered", reason: "route_not_offered" },
        ],
      };
      const html = renderToStaticMarkup(
        <DetailPanel
          port={currentPort}
          status={status}
          sourcePath=""
          setSourcePath={vi.fn()}
          busy={busy}
          actions={actions}
        />,
      );
      const activation = html.match(/<button[^>]*>Apply update · retained-staged<\/button>/)?.[0];
      expect(activation).toBeDefined();
      expect(/\sdisabled(?:=|\s|>)/.test(activation ?? "")).toBe(Boolean(busy));
      expect(html).toContain("Managed by Portcove using this installation");
      expect(html).not.toContain("Choose game executable");
      expect(html).not.toContain("Remove registration");
      expect(html).not.toContain("Stored with your external runtime");
      expect(html).not.toContain("Check for updates</button>");
      expect(html).not.toContain("data-launch-action");
    },
  );
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
    expect(html).toMatch(new RegExp(`<h1[^>]*id="port-detail-title"[^>]*>${port.name}</h1>`));
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
    expect(html).toContain("Detailed setup requirements are unavailable.");
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
    expect(html).not.toContain(">Play</button>");
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
      "Check for updates. If none is available, check installed files for diagnostic details.",
    );
    expect(html).not.toContain("Update required before playing");
    expect(html).not.toContain("Install the available update");
    expect(html).not.toContain(">Play</button>");
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
            source_assessment: confirmedSourceAssessment(),
          },
        }}
      />,
    );
    expect(html).toContain("First-time setup needed");
    expect(html).toContain("Complete the port&#x27;s setup before playing.");
    expect(html).not.toContain("Game files required");
    expect(html).not.toContain("Prepare game data</strong>");
    expect(html).not.toContain("Portcove will run and verify the upstream setup before play.");
  });

  it.each(["opengoal-jak1", "paperboat"])(
    "offers guarded preparation review for the installed %s definition",
    (id) => {
      const definition = currentCatalogPort(id);
      const status: PortStatus = {
        ...portStatus(),
        port_id: id,
        active: installRecord({ port_id: id }),
        readiness: {
          launchable: false,
          blockers: ["preparation_required"],
          pending_setup: true,
          source: "current",
          source_assessment: confirmedSourceAssessment(),
        },
      };
      const props = {
        port: definition,
        status,
        sourcePath: "source.z64",
        setSourcePath: vi.fn(),
        prepare: vi.fn(),
        actions,
      };
      const ready = renderToStaticMarkup(<DetailPanel {...props} />);
      const reviewButton = ready.match(/<button\b[^>]*>Review setup<\/button>/)?.[0];
      expect(reviewButton).toBeDefined();
      expect(reviewButton).not.toMatch(/\sdisabled(?:\s|=|>)/);
      expect(ready).toContain("First-time setup needed");
      expect(ready).not.toContain(">Play</button>");

      const metadataOnly = renderToStaticMarkup(
        <DetailPanel
          {...props}
          status={{
            ...status,
            readiness: {
              ...status.readiness!,
              source: "not_checked",
              source_assessment: null,
            },
          }}
        />,
      );
      const metadataReview = metadataOnly.match(/<button\b[^>]*>Review setup<\/button>/)?.[0];
      expect(metadataReview).toBeDefined();
      expect(metadataReview).not.toMatch(/\sdisabled(?:\s|=|>)/);
      expect(props.prepare).not.toHaveBeenCalled();

      const blocked = [
        { ...props, busy: "prepare" },
        { ...props, prepare: undefined },
        ...(["unregistered", "missing", "unreadable", "changed", "not_baselined"] as const).flatMap(
          (health) => [
            {
              ...props,
              status: { ...status, readiness: { ...status.readiness!, source: health } },
            },
            {
              ...props,
              // These explicit refusal fixtures add a BIOS contract; the embedded ports do not.
              port: { ...definition, bios_source_profile: "required-test-bios" },
              status: { ...status, readiness: { ...status.readiness!, bios: health } },
            },
          ],
        ),
      ];
      for (const refusal of blocked.slice(0, 2)) {
        const html = renderToStaticMarkup(<DetailPanel {...refusal} />);
        const button = html.match(/<button\b[^>]*>Review setup<\/button>/)?.[0];
        expect(button).toBeDefined();
        expect(button).toMatch(/\sdisabled(?:\s|=|>)/);
      }
      for (const missingRequirement of blocked.slice(2)) {
        const html = renderToStaticMarkup(<DetailPanel {...missingRequirement} />);
        expect(html).not.toContain("Review setup");
        expect(html).not.toContain(">Play</button>");
        expect(html).toContain("Requirements");
        expect(html).toContain("Setup needed");
      }
      expect(props.prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["opengoal-jak1", "paperboat"])(
    "does not manufacture preparation review outside the %s managed contract",
    (id) => {
      const definition = currentCatalogPort(id);
      const status: PortStatus = {
        ...portStatus(),
        port_id: id,
        active: installRecord({ port_id: id }),
        readiness: {
          launchable: false,
          blockers: ["preparation_required"],
          pending_setup: true,
          source: "current",
          source_assessment: confirmedSourceAssessment(),
        },
      };
      const props = {
        port: definition,
        status,
        sourcePath: "source.z64",
        setSourcePath: vi.fn(),
        prepare: vi.fn(),
        actions,
      };
      const unavailable = [
        { ...props, port: { ...definition, adapter: "staged-source-portable" as const } },
        { ...props, port: { ...definition, setup_output_paths: [] } },
        { ...props, status: { ...status, active: null } },
        {
          ...props,
          status: {
            ...status,
            readiness: {
              ...status.readiness!,
              launchable: true,
              blockers: [],
              pending_setup: false,
            },
          },
        },
      ];
      for (const outsideContract of unavailable) {
        const html = renderToStaticMarkup(<DetailPanel {...outsideContract} />);
        expect(html).not.toContain("Review setup");
      }
      expect(props.prepare).not.toHaveBeenCalled();
    },
  );

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
    expect(ready).not.toContain('class="hero-reason"');
    // Identity and readiness precede the final hero action row.
    expect(ready.indexOf("Ready to play")).toBeLessThan(
      ready.indexOf('class="detail-header-actions'),
    );
    expect(ready.indexOf('class="detail-header-actions')).toBeLessThan(ready.indexOf("Play"));
    expect(ready.indexOf("Play")).toBeLessThan(ready.indexOf(port.summary));
    expect(ready.indexOf("Play")).toBeLessThan(ready.indexOf("Change artwork"));
    expect(downloaded).toContain("Ready to play");
    expect(downloaded).toContain("Apply update · 1.0");
    expect(downloaded).toContain("Update saved for later · 1.0");
    expect(detailSection(downloaded, "versions")).toContain("Apply update · 1.0");
    expect(downloaded).toContain("data-update-attention");
    expect(downloaded).not.toContain('class="hero-reason"');
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
    expect(html.match(/>Check installed files<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(
      /<div class="actions primary-actions[^"]*"><button[^>]*>.*Check installed files<\/button><\/div>/s,
    );
    expect(html).not.toContain(">Play</button>");
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
    expect(
      checking.match(/<div class="actions primary-actions[^"]*"><button([^>]*)>/)?.[1],
    ).toContain("disabled");
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
            ...(health !== undefined ? { source: health } : {}),
          },
        }}
      />,
    );
    expect(html).toContain(note.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Registered game files");
    expect(html).toMatch(
      /<details class="source-technical[^"]*"><summary[^>]*>File details<\/summary>/u,
    );
    expect(html).toMatch(new RegExp(`Saved SHA-256</strong><code[^>]*>${source.sha256}</code>`));
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
            source_assessment: confirmedSourceAssessment(),
            bios: health,
          },
        }}
      />,
    );
    expect(html).toContain(note.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Registered BIOS file");
    expect(html).toMatch(new RegExp(`Saved SHA-256</strong><code[^>]*>${bios.sha256}</code>`));
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
    expect(html.indexOf("Choose and add the game files again before playing.")).toBeLessThan(
      html.indexOf(port.summary),
    );
    expect(detailSection(html, "manage")).toContain("Managed installation");
    expect(detailSection(html, "files")).toContain("Requirements");
    expect(html).toMatch(/<details class="requirements-disclosure[^"]*" open="">/u);
    expect(detailSection(html, "versions")).toContain("Installed version");
    expect(html).not.toContain(">Play</button>");
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
    expect(html).not.toContain(">Play</button>");
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
      .match(/<button[^>]*>[^]*?Review installation<\/button>/g)
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
              ...(health !== undefined ? { source: health } : {}),
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
            source_assessment: confirmedSourceAssessment(),
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
    expect(html).toContain(">Try launch</button>");
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
        status={{
          ...portStatus(),
          port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    const missingBoth = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, bios_source_profile: psxBiosProfile.id }}
        sourceProfile={{ ...sourceProfile(), id: port.source_profile!, label: "Sample cartridge" }}
        biosProfile={psxBiosProfile}
        sourcePath=""
        setSourcePath={vi.fn()}
        biosPath=""
        setBiosPath={vi.fn()}
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
        source_assessment: confirmedSourceAssessment(),
      },
    };
    const installed = renderToStaticMarkup(
      <DetailPanel
        port={port}
        status={status}
        sourcePath="source.z64"
        source={{
          profile_id: port.source_profile!,
          path: "source.z64",
          sha256: "a".repeat(64),
          size: 1,
          storage_sha256: "a".repeat(64),
          storage_size: 1,
          updated_at: 1,
        }}
        setSourcePath={vi.fn()}
        actions={actions}
        backupCreateAssessment={{
          action: "backup_create",
          availability: "allowed",
          reason: "available",
        }}
        backupReadState={{ status: "current", hasInventory: true }}
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
      ([, content]) =>
        fixtureValue(content, "button HTML capture")
          .replaceAll(/<[^>]+>/g, "")
          .trim(),
    );
    expect(uninstalled).toContain("Choose game files");
    const heroStart = uninstalled.indexOf("data-hero-identity=");
    const tabsStart = uninstalled.indexOf('class="detail-tabs');
    expect(heroStart).toBeGreaterThanOrEqual(0);
    expect(tabsStart).toBeGreaterThan(heroStart);
    expect(uninstalled.slice(heroStart, tabsStart).match(/Needs game files/g)).toHaveLength(1);
    expect(uninstalled).toContain("<dt>Readiness</dt><dd>Needs game files</dd>");
    expect(uninstalled).not.toContain("readiness-card");
    expect(uninstalled.indexOf('class="hero-reason"')).toBeLessThan(
      uninstalled.indexOf("Choose game files"),
    );
    expect(
      uninstalled.indexOf("Choose the required game files before reviewing installation"),
    ).toBeLessThan(uninstalled.indexOf("Choose game files"));
    expect(detailSection(uninstalled, "files")).toContain("Choose game files");
    expect(detailSection(uninstalled, "files")).toContain("Requirements");
    expect(detailSection(uninstalled, "overview")).toContain(port.summary);
    expect(uninstalled).not.toContain("Installation and version");
    expect(uninstalled).toContain("Add all required game files before installing");
    expect(uninstalled).toContain("Choose the required game file");
    expect(detailSection(missingBoth, "files")).toContain("Sample cartridge");
    expect(detailSection(missingBoth, "files")).toContain("PlayStation SCPH-1001 BIOS");
    expect(detailSection(missingBoth, "files")).toContain('aria-label="Game actions"');
    expect(missingBoth).toMatch(
      /<details class="future-setup-disclosure advanced-settings[^"]*">/u,
    );
    expect(
      missingBoth.match(/class="future-setup-disclosure advanced-settings[^"]*"/gu),
    ).toHaveLength(1);
    expect(missingBoth).toContain("Future update preferences");
    expect(missingBoth).toContain("Folder for a future install");
    expect(missingBoth).toContain("Release channel");
    expect(missingBoth).toContain("Folder for future installs");
    expect(uninstalled).toContain(
      "Portcove uses this game file in place and never uploads or changes it.",
    );
    expect(sourceFree).toContain("Review installation");
    expect(sourceFree).toContain("Available to install");
    expect(sourceFree).not.toContain("Needs game files");
    expect(sourceFree).not.toContain("Choose game files");
    expect(sourceFree).not.toContain("Installation and version");
    expect(sourceFree).toContain('data-slot="button"');
    expect(sourceFree).toContain('data-variant="primary"');
    expect(sourceFree).toMatch(/<details class="future-setup-disclosure advanced-settings[^"]*">/u);
    expect(installed).toContain(">Play</button>");
    expect(installed).toContain('class="requirements-disclosure');
    expect(installed).not.toMatch(/<details class="requirements-disclosure[^"]*" open="">/u);
    expect(installed).toMatch(/<button[^>]*data-variant="primary"[^>]*>[^]*?Play<\/button>/u);
    expect(installed).toMatch(/<button[^>]*data-variant="ghost"[^>]*>[^]*?Back<\/button>/u);
    expect(installed).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>(?:(?!<\/button>)[^])*?Check for updates<\/button>/u,
    );
    expect(installed).toMatch(
      /<button[^>]*data-variant="destructive"[^>]*aria-label="Delete backup/u,
    );
    expect(buttonLabels).toContain("Check for updates");
    expect(installed).toContain("Open saved data folder");
    expect(installed).toContain("Back up now");
    expect(installed).toContain('title="Back up saves and settings managed by Portcove."');
    const backupButton = installed.match(
      /<button\b[^>]*aria-describedby="backup-create-explanation"[^>]*>/,
    )?.[0];
    expect(backupButton).toBeDefined();
    expect(backupButton).not.toContain(' disabled=""');
    expect(uninstalled).toContain("Saved-data availability has not been checked.");
    expect(
      uninstalled.match(/<button\b[^>]*aria-describedby="backup-create-explanation"[^>]*>/)?.[0],
    ).toContain(' disabled=""');
    expect(buttonLabels).toContain("Check installed files");
    expect(buttonLabels).toContain("Restore previous version");
    expect(buttonLabels).not.toContain("Check update");
    expect(buttonLabels).not.toContain("Verify");
    expect(buttonLabels).not.toContain("Rollback");
    expect(installed).not.toContain("Create a versioned backup of saves and settings");
    expect(installed).toContain("1 verified backup");
    expect(installed).toContain("Restore");
    expect(installed).toContain("Delete");
    expect(installed).toContain("Uninstall Sample");
    expect(installed).toContain("source.z64");
    expect(uninstalled).not.toMatch(/<details class="advanced-settings[^"]*" open="">/u);
    expect(installed).not.toMatch(/<details class="advanced-settings[^"]*" open="">/u);
    expect(installed).toMatch(/<details class="future-setup-disclosure advanced-settings[^"]*">/u);
    expect(installed).toContain("Saves and settings folder");
    expect(installed).toContain("C:/Portcove/user/sample");
    expect(installed).toContain("No legacy platform coverage recorded");
    expect(installed).toContain("Launch from another app");
    expect(installed).toContain("Finding the command-line app");
    expect(installed).not.toContain("portcove exec sample --");
    expect(installed).toContain("Open upstream project");
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

  it("does not transfer ordinary Linux testing or availability to Steam Deck", () => {
    const renderDetails = (definition: PortDefinition) =>
      renderToStaticMarkup(
        <DetailPanel port={definition} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
      );
    const testedWindowsPort = {
      ...port,
      source_profile: null,
      manually_validated_platforms: ["windows-x86-64"],
    } satisfies PortDefinition;
    const windows = renderDetails(testedWindowsPort);
    const linux = renderDetails({
      ...testedWindowsPort,
      platforms: ["windows-x86-64", "linux-x86-64"],
      automated_tested_platforms: ["windows-x86-64", "linux-x86-64"],
      manually_validated_platforms: ["windows-x86-64", "linux-x86-64"],
    });
    expect(windows).not.toContain("Steam Deck");
    expect(linux.replace(/ class="[^"]*"/gu, "")).toContain("<small>Steam Deck</small>Not tested.");
    expect(linux).toContain(
      "Linux availability does not show whether this game works on SteamOS or in Gaming Mode.",
    );
    expect(linux.replace(/ class="[^"]*"/gu, "")).toContain(
      "<small>Legacy port-wide automated tests</small>Windows · Linux",
    );
    expect(linux.replace(/ class="[^"]*"/gu, "")).toContain(
      "<small>Legacy port-wide hands-on tests</small>Windows · Linux",
    );
    const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[^]*?<\/button>/gu)];
    expect(buttons(linux).map(([button]) => button)).toEqual(
      buttons(windows).map(([button]) => button),
    );
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
      fixtureValue(content, "button HTML capture")
        .replaceAll(/<[^>]+>/g, "")
        .trim(),
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
      fixtureValue(content, "button HTML capture")
        .replaceAll(/<[^>]+>/g, "")
        .trim(),
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
    const sourceInputs = unselected.match(/<input\b[^>]*id="source-[^"]+"[^>]*>/g) ?? [];
    expect(sourceInputs).toHaveLength(2);
    expect(sourceInputs.every((input) => input.includes('data-slot="input"'))).toBe(true);
    expect(unselected).toContain("PlayStation SCPH-1001 BIOS");
    expect(unselected).toContain("Choose the required BIOS file");
    expect(unselected).toContain(
      "Portcove uses this BIOS file in place and never uploads or changes it.",
    );
    expect(unselected).toContain("Choose BIOS file");
    const unselectedButtons = [...unselected.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(
      ([, content]) =>
        fixtureValue(content, "button HTML capture")
          .replaceAll(/<[^>]+>/g, "")
          .trim(),
    );
    expect(unselectedButtons.filter((label) => label === "Choose BIOS file")).toHaveLength(2);
    expect(unselected).toContain("Add the required BIOS file before installing");
    expect(unselected).toContain("Required BIOS file needed");

    const selected = renderToStaticMarkup(
      <DetailPanel
        port={biosPort}
        status={{
          ...portStatus(),
          port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
        }}
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
    expect(selected).toContain("Files selected · not checked");
    expect(selected).not.toContain("Required BIOS file needed");
    expect(selected).toContain(
      "Selected BIOS file has not been checked. Choose Check required BIOS to check and save this location.",
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
    const primary = html.match(/<div class="actions primary-actions[^"]*">(.*?)<\/div>/s)?.[1];
    expect(html).toContain("Game files and BIOS needed");
    expect(primary).toContain("Choose game files and BIOS");
    expect(primary).toContain("Add all required game files and the BIOS file before installing");
  });

  it("keeps direct Play in the header and staged activation with its consequences in Versions", () => {
    const install = installRecord();
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "stage",
      active: install,
      staged: { ...install, id: "2", version: "2.0", staged: true },
      readiness: { launchable: true, blockers: [], pending_setup: false },
    };
    const html = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        status={status}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(html).toContain("Update saved for later · 2.0");
    expect(html).toContain("Apply update · 2.0");
    expect(html.indexOf("Play")).toBeLessThan(html.indexOf("Apply update · 2.0"));
    expect(detailSection(html, "versions")).toContain("Apply update · 2.0");
    expect(detailSection(html, "versions")).toContain("keeps the current version for rollback");
    expect(detailSection(html, "files")).not.toContain("Apply update · 2.0");
    expect(html.match(/Apply update · 2\.0/g)).toHaveLength(1);
    const busyHtml = renderToStaticMarkup(
      <DetailPanel
        port={{ ...port, source_profile: null }}
        status={status}
        sourcePath=""
        setSourcePath={vi.fn()}
        busy="activating staged update"
        actions={actions}
      />,
    );
    expect(busyHtml).toMatch(
      /<button(?=[^>]*staged-action)(?=[^>]*disabled="")[^>]*>Apply update · 2\.0<\/button>/,
    );
  });

  it.each(["missing_runtime", "invalid_installation"] as const)(
    "keeps staged activation reachable when %s blocks Play",
    (blocker) => {
      const active = installRecord();
      const status: PortStatus = {
        ...portStatus(),
        active,
        staged: { ...active, id: "2", version: "2.0", staged: true },
        readiness: { launchable: false, blockers: [blocker], pending_setup: false },
      };
      const html = renderToStaticMarkup(
        <DetailPanel
          port={{ ...port, source_profile: null }}
          status={status}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
        />,
      );
      expect(html).toContain(
        blocker === "missing_runtime" ? "Check for updates" : "Check installed files",
      );
      expect(html).toContain("Apply update · 2.0");
      expect(detailSection(html, "versions")).toContain("Apply update · 2.0");
      expect(detailSection(html, "files")).not.toContain("Apply update · 2.0");
      expect(html.match(/Apply update · 2\.0/g)).toHaveLength(1);
    },
  );

  it("keeps adapter internals out of the primary detail view", () => {
    const html = renderToStaticMarkup(
      <DetailPanel port={port} sourcePath="" setSourcePath={vi.fn()} actions={actions} />,
    );
    expect(html).toContain("Windows");
    expect(html).toContain("Installation method");
    expect(html).toContain("Prepared game files beside the port");
    expect(html).toContain("Sample cartridge");
    expect(html).toContain("Check method: Known file signatures");
    expect(html).not.toContain("Installation and version");
    expect(html).not.toContain("Compared with reviewed catalog identity");
    expect(html).toContain("Managed by Portcove for backup and restore");
    expect(html).toContain("Active");
    expect(html).toContain("Stable · Preview");
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
              {
                ...fixtureValue(requirements[0], "configured game-file requirement"),
                verification: "upstream-validator",
              },
              {
                ...fixtureValue(requirements[0], "configured game-file requirement"),
                role: "bios",
                verification: "catalog-rules",
              },
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

  it("groups detail capabilities by tab and distinguishes installed from eligible versions", () => {
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
    const overview = detailSection(html, "overview");
    const files = detailSection(html, "files");
    const saves = detailSection(html, "saves");
    const versions = detailSection(html, "versions");
    const manage = detailSection(html, "manage");
    for (const content of [
      port.summary,
      "Project status and release information",
      "Compatibility qualifications",
      "Recorded checks",
    ])
      expect(overview).toContain(content);
    for (const content of ['aria-label="Game actions"', "Requirements"])
      expect(files).toContain(content);
    expect(manage).toContain('id="detail-artwork"');
    expect(saves).toContain('aria-labelledby="detail-saves-and-storage"');
    for (const content of ["Managed installation", "Technical details", install.path])
      expect(manage).toContain(content);
    for (const content of ["Saves &amp; backups", "Back up now", "E:/Portcove/user/sample"])
      expect(saves).toContain(content);
    for (const content of [
      "Installed version",
      "Available at last check",
      "2.0",
      "Check for updates",
    ])
      expect(versions).toContain(content);
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
    expect(html).toContain("Preview");
    expect(html).not.toContain("Latest version at last check");
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
    expect(html).toContain("Installed version");
    expect(html).toContain("<strong>1.1</strong>");
    expect(html).not.toContain("Latest version at last check");
    expect(html).not.toContain("9.9-stale");
  });
});

it.each(["g-diffuser", "animal-crossing-pc-port", "openpete"])(
  "offers Core-owned source-only repair for metadata-observed %s originals",
  (id) => {
    const definition = currentCatalogPort(id);
    const status: PortStatus = {
      ...portStatus(),
      port_id: id,
      active: installRecord({ port_id: id }),
      readiness: {
        launchable: false,
        blockers: ["preparation_required"],
        pending_setup: true,
        preparation_mode: "source_only",
        source: "not_checked",
      },
    };
    const prepare = vi.fn();
    const html = renderToStaticMarkup(
      <DetailPanel
        port={definition}
        status={status}
        sourcePath="registered-original"
        setSourcePath={vi.fn()}
        prepare={prepare}
        actions={actions}
      />,
    );
    const review = html.match(/<button\b[^>]*>Review setup<\/button>/)?.[0];
    expect(review).toBeDefined();
    expect(review).not.toMatch(/\sdisabled(?:\s|=|>)/);
    expect(html).not.toContain(">Start setup</button>");
    expect(prepare).not.toHaveBeenCalled();
  },
);

it("keeps Core-permitted launch available while original bytes await an explicit check", () => {
  const definition = currentCatalogPort("g-diffuser");
  const html = renderToStaticMarkup(
    <DetailPanel
      port={definition}
      status={{
        ...portStatus(),
        port_id: definition.id,
        active: installRecord({ port_id: definition.id }),
        readiness: {
          launchable: true,
          blockers: [],
          pending_setup: false,
          preparation_mode: "source_only",
          source: "not_checked",
        },
      }}
      sourceProfile={{ ...sourceProfile(), id: definition.source_profile! }}
      sourcePath="registered-original"
      setSourcePath={vi.fn()}
      prepare={vi.fn()}
      actions={actions}
    />,
  );
  expect(html).toContain(">Try launch</button>");
  expect(html).not.toContain("Select game files");
  expect(html).not.toContain("Review setup");
});

it("uses descriptive display metadata only in the shared detail shell", () => {
  const displayPort = {
    ...port,
    name: "Display project",
    source_profile: "display-only-source",
    presentation: {
      installation_method: "portable-package" as const,
      source_requirements: [],
      saves_and_settings: "external-user-owned" as const,
    },
  };
  const html = renderToStaticMarkup(
    <DetailPanel
      port={port}
      displayPort={displayPort}
      status={{ ...portStatus(), active: installRecord() }}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />,
  );
  const heroStart = html.indexOf("data-hero-identity=");
  const tabsStart = html.indexOf('class="detail-tabs');
  expect(html.slice(heroStart, tabsStart)).toContain("Display project");
  expect(detailSection(html, "manage")).toContain(`Uninstall ${port.name}`);
  expect(detailSection(html, "manage")).not.toContain("Uninstall Display project");
  expect(detailSection(html, "files")).not.toContain('id="source-display-only-source"');
});

it("explains the retained setup and saved-data contract after current metadata changes", () => {
  const current = {
    ...port,
    persistent_paths: ["new-catalog-only"],
    presentation: { ...port.presentation!, manual_preparation: "New catalog guidance" },
  };
  const html = renderToStaticMarkup(
    <DetailPanel
      port={current}
      status={{
        ...portStatus(),
        active: installRecord(),
        readiness: {
          launchable: true,
          blockers: [],
          pending_setup: false,
          setup_contract: {
            definition_sha256: "a".repeat(64),
            retained: true,
            platforms: ["windows-x86-64"],
            installation_method: "portable-package",
            saves_and_settings: "portcove-managed",
            persistent_paths: ["retained-saves"],
            persistent_file_patterns: [],
            manual_preparation: "Original retained guidance",
            manual_setup: null,
            source_requirements: [
              {
                role: "game",
                profile_id: "retained-original",
                label: "Retained original requirement",
                verification: "catalog-identity",
              },
            ],
          },
        },
      }}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />,
  );
  expect(html).toContain("Original retained guidance");
  expect(html).toContain("Retained original requirement");
  const coverage =
    html.match(/<section aria-label="Saved-data coverage">([\s\S]*?)<\/section>/u)?.[1] ?? "";
  expect(coverage).toContain("This installation’s recorded saved-data declarations");
  expect(coverage).toContain("retained-saves");
  expect(coverage).not.toContain("new-catalog-only");
});

it("separates the active version from a downloaded update without implying it is active", () => {
  const active = installRecord({ version: "1.0" });
  const html = renderToStaticMarkup(
    <InstallationVersionSummary
      status={{
        ...portStatus(),
        active,
        staged: { ...active, id: "downloaded", version: "2.0", staged: true },
      }}
      selectedChannel="stable"
    />,
  );
  const current = html.slice(
    html.indexOf('class="detail-version-current"'),
    html.indexOf('class="detail-version-candidate"'),
  );
  const candidate = html.slice(html.indexOf('class="detail-version-candidate"'));
  expect(current).toContain("<strong>1.0</strong>");
  expect(current).not.toContain("<strong>2.0</strong>");
  expect(candidate).toContain("Update saved for later");
  expect(candidate).toContain("<strong>2.0</strong>");
});

it.each(["current", "pending", "failed"] as const)(
  "qualifies the backup journey caption when inventory read is %s",
  (readStatus) => {
    const html = renderToStaticMarkup(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        status={{ ...portStatus(), active: installRecord() }}
        backupReadState={{ status: readStatus, hasInventory: true }}
        backups={[
          {
            id: "b1",
            port_id: port.id,
            path: "backups/sample/b1",
            created_at: 1,
            file_count: 1,
            size: 10,
            sha256: "a".repeat(64),
          },
        ]}
      />,
    );
    const overview = detailSection(html, "overview");
    expect(overview.includes("1 backup")).toBe(readStatus === "current");
    expect(overview.includes("Review backup history")).toBe(readStatus !== "current");
  },
);
