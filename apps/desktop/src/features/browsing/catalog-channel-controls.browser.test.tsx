import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { PortBrowser } from "../../components/PortBrowser";
import { LibrarySelectionCard, SettingsView } from "../../components/Chrome";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { PortDefinition, PortStatus } from "../../types";
import { filterPorts, summarizeLibrary } from "../../view-model";
import { useAppShellState } from "../app-shell/use-app-shell-state";
import type { BrowsingInputs } from "../app-shell/use-app-shell-state";
import type { CatalogQuery } from "./catalog-query";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";

const ports: PortDefinition[] = [
  { ...portDefinition(), id: "stable", name: "Stable port", channels: ["stable"] },
  { ...portDefinition(), id: "beta", name: "Beta port", channels: ["beta"] },
  { ...portDefinition(), id: "rolling", name: "Rolling port", channels: ["rolling"] },
  { ...portDefinition(), id: "both", name: "Both channels", channels: ["stable", "beta"] },
];
const statuses = new Map<string, PortStatus>();
let host: HTMLDivElement;
let root: Root;
let shell: ReturnType<typeof useAppShellState>;
let membershipFacts = false;
const fetchSpy = vi.fn();

function Fixture({ initial }: { initial?: BrowsingInputs }) {
  shell = useAppShellState("catalog", initial);
  const context = membershipFacts ? { library: { id: "selected", statuses } } : {};
  const visible = filterPorts(
    shell.view === "library"
      ? filterPorts(
          ports,
          statuses,
          "library",
          shell.libraryReadiness as "all" | "ready" | "setup",
          "",
        )
      : ports,
    statuses,
    shell.view,
    shell.filter,
    shell.query,
    shell.catalogSort,
    context,
  );
  return (
    <PortBrowser
      view={shell.view}
      queryContext={context}
      catalogFilterCandidates={filterPorts(ports, statuses, "catalog", "all", shell.query)}
      ports={visible}
      libraryReadiness={shell.libraryReadiness}
      setLibraryReadiness={shell.setLibraryReadiness}
      libraryFilterCandidates={filterPorts(ports, statuses, "library", "all", shell.query)}
      statuses={statuses}
      overview={summarizeLibrary(ports, statuses)}
      filter={shell.filter}
      query={shell.query}
      setFilter={shell.setFilter}
      onSelect={shell.setSelectedId}
      clearFilters={() => {
        shell.setFilter("all");
        shell.setLibraryReadiness("all");
        shell.setQuery("");
      }}
      loading={false}
    />
  );
}

async function restore(filter: CatalogQuery | "beta" | "all") {
  const initial = {
    ...shell.browsingInputs,
    sections: {
      ...shell.browsingInputs.sections,
      catalog: { filter, query: "" },
    },
  };
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Fixture initial={initial} />));
}

async function click(name: string) {
  await act(async () => channelButton(name).click());
}

function channelButton(name: string) {
  const label = name === "beta" ? "preview" : name === "all" ? "all ports" : name;
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Release channel filters"] button'),
  ].find((item) => item.textContent?.trim().toLowerCase() === label);
  expect(button).toBeDefined();
  return button!;
}

function visibleIds() {
  return [...host.querySelectorAll('[data-detail-origin^="catalog:card:"]')].map((item) =>
    item.getAttribute("data-detail-origin")!.slice("catalog:card:".length),
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchSpy);
  vi.clearAllMocks();
  statuses.clear();
  membershipFacts = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Fixture />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Catalog channel controls", () => {
  it("retains a rejected switch's technical projection without opening details or retrying", async () => {
    const target = "E:/qualification/alternate-library";
    const switchLibrary = vi.fn().mockRejectedValue({
      code: "conflict",
      message: "outgoing library lease is held",
      details: { library_root: "E:/qualification/original-library" },
      presentation: {
        summary: "The selection changed or another operation is using it.",
        technical_message: "outgoing library lease is held",
        technical_context: { library_root: "E:/qualification/original-library" },
        mutation_state: "unknown",
        phase: null,
        recovery_actions: [],
      },
    });
    await act(async () =>
      root.render(
        <LibrarySelectionCard
          choose={vi.fn().mockResolvedValue(target)}
          switchLibrary={switchLibrary}
        />,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-library-selection-trigger="switch"]')!.click(),
    );
    const confirmation = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent === "Switch library")!;
    await act(async () => confirmation.click());
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("The selection changed");
    expect(alert.querySelector("details")!.open).toBe(false);
    const projection: unknown = JSON.parse(
      alert.querySelector(".failure-details pre")!.textContent ?? "null",
    );
    expect(projection).toEqual({
      mutation_state: "unknown",
      phase: null,
      message: "outgoing library lease is held",
      context: { library_root: "E:/qualification/original-library" },
    });
    expect(projection).not.toHaveProperty("code");
    expect(alert.querySelector("details")!.open).toBe(false);
    expect(switchLibrary).toHaveBeenCalledExactlyOnceWith(target);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("binds the native switch confirmation selector to the rendered reviewed action", async () => {
    const { default: nativeHarnessSource } = await import("../../../scripts/desktop-test.mts?raw");
    const target = "E:/qualification/alternate-library";
    const switchLibrary = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <LibrarySelectionCard
          choose={vi.fn().mockResolvedValue(target)}
          switchLibrary={switchLibrary}
        />,
      ),
    );
    const choose = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Choose another library",
    )!;
    await act(async () => choose.click());
    const review = document.querySelector('[aria-labelledby="library-selection-review-title"]')!;
    expect(review.textContent).toContain(target);
    expect(switchLibrary).not.toHaveBeenCalled();
    const scenario = nativeHarnessSource.slice(
      nativeHarnessSource.indexOf('await scenario("native-library-browsing-context"'),
      nativeHarnessSource.indexOf("await catalogUpdateScenario"),
    );
    const selector = scenario.match(
      /By\.xpath\('(\.\/\/button\[normalize-space\(\.\)="Switch [^"]+"\])'\)/u,
    )?.[1];
    expect(selector).toBeDefined();
    const confirmation = document.evaluate(
      selector!,
      review,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue as HTMLButtonElement | null;
    expect(confirmation).not.toBeNull();
    expect(confirmation!.disabled).toBe(false);
    await act(async () => confirmation!.click());
    expect(switchLibrary).toHaveBeenCalledExactlyOnceWith(target);
    expect(document.querySelector('[aria-labelledby="library-selection-review-title"]')).toBeNull();
  });
  it("binds the existing native library-switch lease observer to the rendered GitHub connection", () => {
    const settings = new DOMParser().parseFromString(
      renderToStaticMarkup(<SettingsView />),
      "text/html",
    );
    expect(settings.querySelector(".github-auth")).toBeNull();
    const connection = settings.evaluate(
      '//article[.//h2[normalize-space(.)="GitHub connection"]]',
      settings,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
    expect(connection?.textContent).toContain("Connection status unavailable");
  });
  it("keeps Stable and Preview selected with compatible beta query values", async () => {
    await act(async () => channelButton("stable").click());
    expect(visibleIds()).toEqual(["stable", "both"]);
    await act(async () => channelButton("beta").click());
    expect(visibleIds()).toEqual(["stable", "beta", "both"]);
    expect(channelButton("stable").getAttribute("aria-pressed")).toBe("true");
    expect(channelButton("beta").getAttribute("aria-pressed")).toBe("true");
    expect(channelButton("rolling").getAttribute("aria-pressed")).toBe("false");
  });

  it("removes one or the last channel and explicitly resets all channels", async () => {
    await click("stable");
    await click("beta");
    await click("stable");
    expect(visibleIds()).toEqual(["beta", "both"]);
    await click("beta");
    expect(visibleIds()).toEqual(["stable", "beta", "rolling", "both"]);
    expect(channelButton("all").getAttribute("aria-pressed")).toBe("true");
    await click("rolling");
    await click("stable");
    await click("beta");
    expect(visibleIds()).toEqual(["stable", "beta", "rolling", "both"]);
    await click("all");
    for (const channel of ["stable", "beta", "rolling"])
      expect(channelButton(channel).getAttribute("aria-pressed")).toBe("false");
  });

  it("consumes a supported legacy selection without losing it on the next toggle", async () => {
    await restore("beta");
    expect(visibleIds()).toEqual(["beta", "both"]);
    await click("stable");
    expect(visibleIds()).toEqual(["stable", "beta", "both"]);
  });

  it("preserves other constraints for channel toggles and clears declared filters with All ports", async () => {
    await restore({ version: 1, channels: ["stable"], platforms: ["linux-x86-64"] });
    await click("beta");
    expect(visibleIds()).toEqual([]);
    expect(shell.filter).toEqual({
      version: 1,
      channels: ["stable", "beta"],
      platforms: ["linux-x86-64"],
    });
    expect(channelButton("all").getAttribute("aria-pressed")).toBe("false");
    await click("stable");
    await click("beta");
    expect(visibleIds()).toEqual([]);
    expect(shell.filter).toEqual({ version: 1, channels: [], platforms: ["linux-x86-64"] });
    expect(channelButton("all").getAttribute("aria-pressed")).toBe("false");
    await click("all");
    expect(shell.filter).toBe("all");
    expect(visibleIds()).toEqual(["stable", "beta", "rolling", "both"]);
    expect(channelButton("all").getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    { version: 2, channels: ["stable"] },
    { version: 1, channels: ["renamed-channel"] },
    { version: 1, channels: 42 } as unknown as CatalogQuery,
  ])("holds unsupported restored queries until explicit reset: %j", async (filter) => {
    await restore(filter);
    expect(visibleIds()).toEqual([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("not supported");
    expect(channelButton("beta").disabled).toBe(true);
    await click("beta");
    expect(shell.filter).toEqual(filter);
    await click("all");
    expect(visibleIds()).toHaveLength(4);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains search, sort, selection and control focus without backend or network work", async () => {
    await act(async () => {
      shell.setQuery("port");
      shell.setCatalogSort("name");
      shell.setSelectedId("stable");
    });
    channelButton("beta").focus();
    await click("beta");
    expect(document.activeElement).toBe(channelButton("beta"));
    expect(shell).toMatchObject({ query: "port", catalogSort: "name", selectedId: "stable" });
    expect(visibleIds()).toEqual(["beta", "both"]);
    await click("stable");
    expect(visibleIds()).toEqual(["beta", "both", "stable"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps mounted Library readiness independent of Catalog channels", async () => {
    for (const [id, launchable] of [
      ["stable", true],
      ["beta", false],
    ] as const) {
      statuses.set(id, {
        ...portStatus(),
        port_id: id,
        active: {
          id: "1",
          port_id: id,
          version: "1.0",
          path: `${id}/1.0`,
          channel: "stable",
          installed_at: 1,
          verified: true,
          staged: false,
          artifact: { asset_name: `${id}.zip`, sha256: "b".repeat(64), size: 1 },
          manifest_sha256: "c".repeat(64),
          selected_executable: `${id}.exe`,
          runtime: null,
        },
        readiness: { launchable, blockers: [], pending_setup: !launchable },
      });
    }
    await click("beta");
    await click("stable");
    await act(async () => shell.setView("library"));
    const readiness = page.getByRole("combobox", { name: /^Readiness / });
    await readiness.click();
    await page.getByRole("option", { name: "Ready (1)", exact: true }).click();
    expect(
      [...host.querySelectorAll("article.port-card")].map(
        (card) => card.querySelector('[role="heading"][aria-level="2"]')?.textContent,
      ),
    ).toEqual(["Stable port"]);
    await readiness.click();
    await page.getByRole("option", { name: "Needs attention (1)", exact: true }).click();
    expect(
      [...host.querySelectorAll("article.port-card")].map(
        (card) => card.querySelector('[role="heading"][aria-level="2"]')?.textContent,
      ),
    ).toEqual(["Beta port"]);
    await act(async () => shell.setView("catalog"));
    expect(visibleIds()).toEqual(["stable", "beta", "both"]);
    await act(async () => shell.setView("library"));
    await expect.element(readiness).toHaveAccessibleName("Readiness Needs attention (1)");
  });
});

it("feeds the accepted membership context consistently into results, counts and unavailable restoration", async () => {
  statuses.set("both", {
    ...portStatus(),
    port_id: "both",
    external_runtime: {
      id: "external",
      port_id: "both",
      path: "/fixture",
      executable: "game.exe",
      platform: "windows-x86-64",
      version: "1",
      registered_at: 1,
      archive_sha256: "a".repeat(64),
      immutable_tree_sha256: "b".repeat(64),
    },
  });
  membershipFacts = true;
  await act(async () => root.render(<Fixture />));
  const control = (name: string) => {
    const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
    );
    expect(result).toBeDefined();
    return result!;
  };
  await act(async () => control("Filters (0)").click());
  await act(async () => control("In my library (1)").click());
  expect(visibleIds()).toEqual(["both"]);
  expect(control("Preview (unavailable)").disabled).toBe(true);
  await act(async () =>
    shell.setFilter({ version: 1, membership: ["in-library"], channels: ["beta"] }),
  );
  expect(visibleIds()).toEqual([]);
  expect(document.body.textContent).toContain("Ports unavailable");
  membershipFacts = false;
  await act(async () => root.render(<Fixture />));
  expect(document.body.textContent).toContain("Ports unavailable");
  expect(visibleIds()).toEqual([]);
  expect(control("Remove In my library filter")).toBeDefined();
  await act(async () => control("Remove In my library filter").click());
  expect(visibleIds()).toEqual(["beta", "both"]);
  expect(shell.filter).toEqual({ version: 1, membership: [], channels: ["beta"] });
  expect(invoke).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("composes raw Core attention with readiness/channel counts and keeps unavailable intent without I/O", async () => {
  statuses.set("both", {
    ...portStatus(),
    port_id: "both",
    external_runtime: {
      id: "external",
      port_id: "both",
      path: "/fixture",
      executable: "game.exe",
      platform: "windows-x86-64",
      version: "1",
      registered_at: 1,
      archive_sha256: "a".repeat(64),
      immutable_tree_sha256: "b".repeat(64),
    },
    readiness: { launchable: true, pending_setup: true, blockers: ["changed_source"] },
  });
  membershipFacts = true;
  await act(async () => root.render(<Fixture />));
  const control = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
    )!;
  await act(async () => control("Filters (0)").click());
  expect(control("Missing game files (0)")).toBeDefined();
  await act(async () => control("Finish setup (1)").click());
  expect(visibleIds()).toEqual(["both"]);
  expect(control("Preview (unavailable)").disabled).toBe(true);
  await act(async () =>
    shell.setFilter({ version: 1, attention: ["finish-setup"], channels: ["beta"] }),
  );
  expect(visibleIds()).toEqual([]);
  expect(document.body.textContent).toContain("Ports unavailable");
  membershipFacts = false;
  await act(async () => root.render(<Fixture />));
  expect(document.body.textContent).toContain("Ports unavailable");
  expect(visibleIds()).toEqual([]);
  await act(async () => control("Remove Finish setup filter").click());
  expect(visibleIds()).toEqual(["beta", "both"]);
  expect(shell.filter).toMatchObject({ attention: [], channels: ["beta"] });
  expect(invoke).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("feeds identity-matched staged updates into results/counts without update checks or mutation", async () => {
  const active = {
    id: "active",
    port_id: "both",
    version: "1",
    path: "/fixture",
    channel: "stable" as const,
    installed_at: 1,
    verified: true,
    staged: false,
    artifact: { asset_name: "game.zip", sha256: "a".repeat(64), size: 1 },
    manifest_sha256: "b".repeat(64),
    selected_executable: "game.exe",
    runtime: null,
  };
  const staged = {
    ...active,
    id: "staged",
    version: "2",
    staged: true,
    artifact: { ...active.artifact, sha256: "c".repeat(64) },
  };
  statuses.set("both", {
    ...portStatus(),
    port_id: "both",
    active,
    staged,
    readiness: { launchable: true, pending_setup: false, blockers: [] },
    last_update_check: {
      checked_at: 10,
      check: {
        port_id: "both",
        channel: "stable",
        installed_version: "1",
        installed_artifact: { ...active.artifact },
        installed_runtime: null,
        required_runtime: null,
        update_available: true,
        release: {
          version: "2",
          channel: "stable",
          published_at: null,
          asset: {
            name: "game.zip",
            sha256: "c".repeat(64),
            size: 1,
            url: "https://example.com/game.zip",
          },
        },
      },
    },
  });
  membershipFacts = true;
  await act(async () => root.render(<Fixture />));
  const control = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
    )!;
  await act(async () => control("Filters (0)").click());
  await act(async () => control("Matching update staged (1)").click());
  expect(visibleIds()).toEqual(["both"]);
  expect(control("Available at last check (0)")).toBeDefined();
  expect(control("Preview (unavailable)").disabled).toBe(true);
  await act(async () => shell.setFilter({ version: 1, updates: ["staged"], channels: ["beta"] }));
  membershipFacts = false;
  await act(async () => root.render(<Fixture />));
  expect(document.body.textContent).toContain("Ports unavailable");
  await act(async () => control("Remove Matching update staged filter").click());
  expect(visibleIds()).toEqual(["beta", "both"]);
  expect(invoke).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});
