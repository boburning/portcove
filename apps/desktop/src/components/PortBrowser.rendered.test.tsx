import { portStatus, confirmedSourceAssessment } from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { GameUpdateAcquisition, PortStatus } from "../types";
import { PortBrowser } from "./PortBrowser";
import { port, installRecord, runtimeIdentity } from "./rendered-test-fixtures";

describe("desktop components", () => {
  it.each(["library", "catalog"] as const)(
    "keeps downloaded archives, prepared runtimes and active Play distinct in %s",
    (view) => {
      const active = installRecord();
      const acquisition: GameUpdateAcquisition = {
        id: "owned-archive",
        port_id: port.id,
        platform: "windows-x86-64",
        phase: "acquired",
        created_at: 1,
        updated_at: 2,
        release: {
          version: "2",
          channel: "stable",
          published_at: null,
          asset: {
            name: "update.zip",
            sha256: "a".repeat(64),
            size: 1,
            url: "https://example.com/update.zip",
          },
        },
      };
      const base: PortStatus = {
        ...portStatus(),
        port_id: port.id,
        active,
        readiness: {
          launchable: true,
          pending_setup: false,
          blockers: [],
          source: "current",
          source_assessment: confirmedSourceAssessment(),
        },
      };
      const render = (status: PortStatus) =>
        renderToStaticMarkup(
          <PortBrowser
            view={view}
            ports={[port]}
            statuses={new Map([[port.id, status]])}
            overview={{ installed: 1, ready: 1, needsSetup: 0, staged: status.staged ? 1 : 0 }}
            filter="all"
            setFilter={vi.fn()}
            onSelect={vi.fn()}
            onContinue={vi.fn()}
            loading={false}
          />,
        );
      expect(render(base)).not.toContain("Archive downloaded");
      expect(render(base)).not.toContain("Update saved for later");
      const downloaded = render({ ...base, acquisition });
      expect(downloaded).toContain("Archive downloaded");
      expect(downloaded).not.toContain("Update saved for later");
      expect(downloaded).toContain("Ready to play");
      const prepared = render({
        ...base,
        staged: installRecord({ id: "prepared", staged: true, version: "2" }),
      });
      expect(prepared).toContain(
        view === "library" ? "Update saved for later" : "Update saved for later",
      );
      expect(prepared).not.toContain("Archive downloaded");
    },
  );

  it.each(
    (["library", "catalog"] as const).flatMap((view) =>
      [
        "same target",
        "newer release",
        "different artifact",
        "different asset name",
        "different asset size",
        "different channel",
        "different required runtime",
        "different downloaded runtime",
        "different port",
        "unverified download",
        "unknown artifact",
        "stale installed version",
        "stale installed artifact",
        "stale installed runtime",
        "stale selected channel",
        "stale active port",
        "stale checked port",
        "stale installed name",
        "stale installed size",
        "unspecified asset size",
      ].map((difference) => ({ view, difference })),
    ),
  )("matches downloaded attention in $view: $difference", ({ view, difference }) => {
    const install = installRecord();
    const downloaded = installRecord({ id: "2", version: "2.0", staged: true });
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      active: install,
      staged: downloaded,
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
        source: "current",
        source_assessment: confirmedSourceAssessment(),
      },
      last_update_check: {
        checked_at: 2,
        check: {
          port_id: port.id,
          channel: "stable",
          installed_version: install.version,
          installed_artifact: install.artifact,
          installed_runtime: install.runtime,
          required_runtime: downloaded.runtime,
          update_available: true,
          release: {
            version: downloaded.version,
            channel: downloaded.channel,
            published_at: null,
            asset: {
              name: downloaded.artifact.asset_name,
              sha256: downloaded.artifact.sha256,
              size: downloaded.artifact.size,
              url: "https://example.com/sample.zip",
            },
          },
        },
      },
    };
    const check = status.last_update_check?.check;
    if (!check) throw new Error("Current update fixture is required");
    const mutate: Record<string, () => void> = {
      "newer release": () => {
        check.release.version = "3.0";
      },
      "different artifact": () => {
        check.release.asset.sha256 = "e".repeat(64);
      },
      "different asset name": () => {
        check.release.asset.name = "other.zip";
      },
      "different asset size": () => {
        check.release.asset.size = 2;
      },
      "different channel": () => {
        downloaded.channel = "beta";
      },
      "different required runtime": () => {
        check.required_runtime = runtimeIdentity;
      },
      "different downloaded runtime": () => {
        downloaded.runtime = runtimeIdentity;
      },
      "different port": () => {
        downloaded.port_id = "other-port";
      },
      "unverified download": () => {
        downloaded.verified = false;
      },
      "unknown artifact": () => {
        downloaded.artifact = { ...downloaded.artifact, sha256: "" };
        check.release.asset.sha256 = "";
      },
      "stale installed version": () => {
        check.installed_version = "0.9";
      },
      "stale installed artifact": () => {
        check.installed_artifact = { ...install.artifact, sha256: "e".repeat(64) };
      },
      "stale installed runtime": () => {
        check.installed_runtime = runtimeIdentity;
      },
      "stale selected channel": () => {
        status.channel = "beta";
      },
      "stale active port": () => {
        status.active!.port_id = "other";
      },
      "stale checked port": () => {
        check.port_id = "other";
      },
      "stale installed name": () => {
        check.installed_artifact = { ...install.artifact, asset_name: "old.zip" };
      },
      "stale installed size": () => {
        check.installed_artifact = { ...install.artifact, size: 2 };
      },
      "unspecified asset size": () => {
        check.release.asset.size = 0;
      },
    };
    mutate[difference]?.();
    const html = renderToStaticMarkup(
      <PortBrowser
        view={view}
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 1 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(html).toContain("Ready to play");
    expect(html).toContain(
      view === "library" ? "Update saved for later" : "Update saved for later</span>",
    );
    const expectedAvailable =
      difference !== "same target" &&
      difference !== "unspecified asset size" &&
      difference !== "unknown artifact" &&
      !difference.startsWith("stale ");
    expect(
      html.includes(
        view === "library"
          ? "Another update available at last check"
          : ">Update available at last check<",
      ),
    ).toBe(expectedAvailable);
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
        setCatalogSort={vi.fn()}
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
    expect(cards).toContain("Catalog order");
    expect(cards).toContain("Sort");
    expect(cards).toContain("Setup status unknown");
    expect(cards).toContain("Installation status unknown");
    expect(cards).toContain("Windows");
    expect(cards).not.toContain(port.summary);
    expect(cards).not.toContain("Stable channel");
    expect(cards).not.toContain('<span class="badge stable">Stable</span>');
    expect(cards).not.toContain("staged-source-portable");
    expect(empty).toContain("No matching games");
    expect(empty).toContain("No games match the current filters and view.");
    expect(empty).not.toContain("The catalog itself has not been changed.");
    expect(empty).toContain("Reset view");
    expect(emptyLibrary).toContain("/brand/mascot/portcove-mascot-v2-front.png");
    expect(emptyLibrary).toContain('aria-hidden="true"');
    expect(emptyLibrary).toContain("Your library is empty");
    expect(emptyLibrary).toContain("using your original files");
    expect(emptyLibrary).toContain("Add games");
    expect(emptyLibrary).not.toContain('aria-label="Library readiness"');
    expect(emptyLibrary).not.toContain('aria-label="Library filters"');
    expect(emptyLibrary).toContain("copy a supported installation");
    expect(emptyLibrary.toLowerCase()).not.toContain("adopt");
    expect(emptyLibrary).not.toContain("Reset view");
    expect(filteredEmptyLibrary).toContain("No matching library entries");
    expect(filteredEmptyLibrary).toContain('aria-label="Library filters"');
    expect(filteredEmptyLibrary).toContain("Reset view");
    expect(filteredEmptyLibrary).toContain(
      "Reset filters, quick views and collection selection to browse again.",
    );
    expect(filteredEmptyLibrary).not.toContain("Your installed ports are still in this library.");
    expect(filteredEmptyLibrary).not.toContain("Your library is empty");
    expect(loading).toContain("/brand/logo/portcove-logo-v2-transparent.png");
    expect(loading).toContain('alt="Portcove"');
    expect(loading).toContain("Loading the catalog, added game files, and ports in your library.");
    expect(loading).not.toContain("shared local catalog");
  });

  it("shows per-entry play readiness and a separate available-update review", () => {
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
        source_assessment: confirmedSourceAssessment(),
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
    expect(html).toContain(`aria-label="View details for ${port.name} ${port.name}"`);
    expect(html).not.toContain(">Details</button>");
    expect(html).toContain(`aria-label="More actions for ${port.name}"`);
    expect(html).toContain('data-slot="button"');
    expect(html).toContain('data-variant="link"');
    const play = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)
      ?.find((button) => button.endsWith(">Play</button>"));
    expect(play).toBeDefined();
    expect(play).toContain('data-variant="ghost"');
    expect(play).not.toContain('data-variant="primary"');
    expect(html).not.toContain("Release channel: Stable");
    expect(html).toMatch(/<article class="port-card [^"]*\bport-card-library\b/u);
    expect(html).toContain(">Play</button>");
    expect(html).not.toMatch(/<button[^>]*class="port-card/u);
    expect(html).toContain("Ready to play");
    expect(html).not.toContain("updates downloaded");
    expect(html).toContain("Update available at last check");
    expect(html).not.toContain("need attention");
    expect(html).not.toContain("Launch ready");
    expect(html).not.toContain("Play options");
    expect(html).not.toContain("Staged updates");
    expect(html).not.toContain("rollback-safe");
    const card = html.match(
      /<article class="port-card [^"]*\bport-card-library\b[^>]*>[\s\S]*?<\/article>/u,
    )?.[0];
    expect(card).toBeDefined();
    expect(card).toMatch(
      /role="heading" aria-level="2"[^>]*>Sample Port<\/span>[\s\S]*?Update available at last check/u,
    );
    expect(card).not.toContain(port.summary);
    expect(card).not.toContain(">Windows</span>");
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
        source_assessment: confirmedSourceAssessment(),
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

    expect(html).toContain("Update saved for later");
    expect(html).toMatch(
      /role="heading" aria-level="2"[^>]*>Sample Port<\/span>[\s\S]*?Update saved for later/u,
    );
    expect(html).toContain("View details for Sample Port");
    expect(html).not.toContain("Update staged");
    expect(html).not.toContain("Staged updates");
  });

  it.each([
    {
      readiness: {
        launchable: true,
        blockers: [],
        pending_setup: false,
        source: "current",
        source_assessment: confirmedSourceAssessment(),
      },
      label: "Ready to play",
      action: "View installation",
    },
    {
      readiness: {
        launchable: false,
        blockers: ["missing_runtime"],
        pending_setup: false,
        source: "current",
        source_assessment: confirmedSourceAssessment(),
      },
      label: "Runtime required",
      action: "View installation",
    },
    { readiness: null, label: "Readiness unavailable", action: "View installation" },
  ] satisfies { readiness: PortStatus["readiness"]; label: string; action: string }[])(
    "prioritizes a prepared update while retaining $label eligibility and exact installation review in Discover",
    ({ readiness, label, action }) => {
      const install = installRecord();
      const status: PortStatus = {
        ...portStatus(),
        port_id: port.id,
        active: install,
        staged: { ...install, id: "2", version: "2.0", staged: true },
        readiness,
      };
      const html = renderToStaticMarkup(
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          overview={{ installed: 1, ready: 0, needsSetup: 0, staged: 1 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={vi.fn()}
          loading={false}
        />,
      );
      const card = html.match(
        /<article[^>]*data-discover-port-ids=[^>]*>[\s\S]*?<\/article>/u,
      )?.[0];
      expect(card).toBeDefined();
      expect(card).toContain("Sample Port");
      expect(card?.includes(`${label}</span>`)).toBe(label !== "Ready to play");
      expect(card).toContain("Update saved for later</span>");
      expect(card).toContain(`${action}<`);
      expect(card).toContain(`data-detail-origin="catalog:card:${port.id}:details"`);
      expect(html).toContain("Update saved for later</span>");
    },
  );

  it.each([0, 1])(
    "labels a playable spotlight from its recorded successful launch count %s",
    (launches) => {
      const install = installRecord();
      const recentStatus: PortStatus = {
        ...portStatus(),
        port_id: port.id,
        channel: "stable",
        update_policy: "notify",
        active: install,
        last_launched_at: 100,
        successful_launches: launches,
        readiness: {
          launchable: true,
          blockers: [],
          pending_setup: false,
          source: "current",
          source_assessment: confirmedSourceAssessment(),
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
      expect(html).toContain(launches ? "Continue playing" : `aria-label="Play ${port.name}"`);
      expect(html).toContain(launches ? "Continue playing" : ">Play</button>");
      expect(html).not.toContain(`Version ${install.version}`);
      expect(html).not.toContain("Last played ·");
      expect(html).toContain(`data-successful-launches="${launches}"`);
      expect(html).toContain(`data-detail-origin="library:continue-details:${port.id}"`);
      expect(html).toContain(`data-detail-origin="library:card:${port.id}"`);
      expect(html).not.toContain("Last successful session");
    },
  );

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
    expect(html).not.toContain("Continue playing");
  });
});
