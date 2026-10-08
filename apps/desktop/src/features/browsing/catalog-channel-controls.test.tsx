// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import nativeHarnessSource from "../../../scripts/desktop-test.mjs?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortBrowser } from "../../components/PortBrowser";
import { LibrarySelectionCard, SettingsView } from "../../components/Chrome";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { PortDefinition, PortStatus } from "../../types";
import { filterPorts, summarizeLibrary } from "../../view-model";
import { useAppShellState } from "../app-shell/use-app-shell-state";
import type { BrowsingInputs } from "../app-shell/use-app-shell-state";
import type { CatalogQuery } from "./catalog-query";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
const fetchSpy = vi.fn();

function Fixture({ initial }: { initial?: BrowsingInputs }) {
  shell = useAppShellState("catalog", initial);
  const visible = filterPorts(
    ports,
    statuses,
    shell.view,
    shell.filter,
    shell.query,
    shell.catalogSort,
  );
  return (
    <PortBrowser
      view={shell.view}
      ports={visible}
      statuses={statuses}
      overview={summarizeLibrary(ports, statuses)}
      filter={shell.filter}
      query={shell.query}
      setFilter={shell.setFilter}
      onSelect={shell.setSelectedId}
      clearFilters={() => {
        shell.setFilter("all");
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
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Release channel filters"] button'),
  ].find((item) => item.textContent?.trim().toLowerCase() === name);
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
  it("binds the native switch confirmation selector to the rendered reviewed action", async () => {
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
  it("keeps Stable and Beta selected and displays their union once", async () => {
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

  it("preserves other structured constraints when toggling or clearing channels", async () => {
    await restore({ version: 1, channels: ["stable"], platforms: ["linux-x86-64"] });
    await click("beta");
    expect(visibleIds()).toEqual([]);
    expect(shell.filter).toEqual({
      version: 1,
      channels: ["stable", "beta"],
      platforms: ["linux-x86-64"],
    });
    await click("all");
    expect(visibleIds()).toEqual([]);
    expect(shell.filter).toEqual({ version: 1, channels: [], platforms: ["linux-x86-64"] });
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Clear search and filters"),
    );
    expect(reset).toBeDefined();
    await act(async () => reset!.click());
    expect(visibleIds()).toHaveLength(4);
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

  it("keeps mounted Library readiness shortcuts independent of Catalog channels", async () => {
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
    const libraryButton = (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Library filters"] button')].find(
        (item) => item.textContent === name,
      )!;
    await act(async () => libraryButton("Ready").click());
    expect(
      [...host.querySelectorAll("article.port-card")].map(
        (card) => card.querySelector("h2")?.textContent,
      ),
    ).toEqual(["Stable port"]);
    await act(async () => libraryButton("Needs attention").click());
    expect(
      [...host.querySelectorAll("article.port-card")].map(
        (card) => card.querySelector("h2")?.textContent,
      ),
    ).toEqual(["Beta port"]);
    await act(async () => shell.setView("catalog"));
    expect(visibleIds()).toEqual(["stable", "beta", "both"]);
    await act(async () => shell.setView("library"));
    expect(libraryButton("Needs attention").getAttribute("aria-pressed")).toBe("true");
  });
});
