import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { CatalogFilters } from "./CatalogFilters";
import type { CatalogQuery, CatalogQueryContext } from "./catalog-query";
import { portDefinition, portStatus } from "../../test-fixtures";
import { filterPorts, type Filter } from "../../view-model";
import type { CatalogBrowsingContext, CatalogBrowsingSnapshot, PortStatus } from "../../types";

const ports = [
  {
    ...portDefinition(),
    id: "windows",
    name: "Windows game",
    platforms: ["windows-x86-64"] as const,
    channels: ["stable"] as const,
  },
  {
    ...portDefinition(),
    id: "linux",
    name: "Linux game",
    platforms: ["linux-x86-64"] as const,
    channels: ["beta"] as const,
  },
  {
    ...portDefinition(),
    id: "both",
    name: "Both game",
    platforms: ["windows-x86-64", "linux-x86-64"] as const,
    channels: ["stable", "beta"] as const,
  },
].map((port) => ({ ...port, platforms: [...port.platforms], channels: [...port.channels] }));
let host: HTMLDivElement;
let root: RenderResult;
let current: Filter | CatalogQuery;
let currentSearch = "";
let setQuery: (value: string) => void;
let setFavoritesOnly: (value: boolean) => void;
let setContext: (value: CatalogQueryContext | undefined) => void;
function retainedContext(statuses: ReadonlyMap<string, PortStatus>): CatalogQueryContext {
  let identity = 0;
  const contexts: CatalogBrowsingContext[] = [];
  for (const port of ports) {
    const status = statuses.get(port.id);
    const member = Boolean(status?.active || status?.external_runtime);
    const fact = {
      port_id: port.id,
      port_member: member,
      definition_sha256: "a".repeat(64),
      instance_sha256: null,
      installation_id: null,
      installation_method: "portable-package" as const,
      release_version: null,
      artifact_sha256: null,
    };
    for (const platform of port.platforms)
      for (const channel of port.channels)
        contexts.push({
          ...fact,
          context_id: (++identity).toString(16).padStart(64, "0"),
          route: "managed_install",
          platform,
          channel,
          member_context: false,
        });
    const instance = status?.active ?? status?.external_runtime;
    if (instance)
      contexts.push({
        ...fact,
        context_id: (++identity).toString(16).padStart(64, "0"),
        route: status?.active ? "managed_launch" : "external_launch",
        platform: status?.external_runtime?.platform ?? "windows-x86-64",
        channel: status?.active?.channel ?? "stable",
        member_context: true,
        installation_id: instance.id,
        instance_sha256: "b".repeat(64),
      });
  }
  const browsing: CatalogBrowsingSnapshot = {
    schema_version: 1,
    contexts,
    library: { id: "opaque", root: "selected" },
    host_platform: "windows-x86-64",
    retained_metadata_complete: true,
    workspace_binding_sha256: "c".repeat(64),
  };
  return {
    library: { id: "selected", statuses },
    browsing,
    devicePlatform: browsing.host_platform,
  };
}
function Fixture({ initial = "all" }: { initial?: Filter | CatalogQuery | undefined }) {
  const [filter, setFilter] = useState(initial);
  const [context, contextSetter] = useState<CatalogQueryContext>();
  setContext = contextSetter;
  const [search, searchSetter] = useState("");
  const [favoriteOnly, favoriteSetter] = useState(false);
  current = filter;
  currentSearch = search;
  setQuery = searchSetter;
  setFavoritesOnly = favoriteSetter;
  const candidates = filterPorts(ports, new Map(), "catalog", "all", search).filter(
    (port) => !favoriteOnly || port.id === "both",
  );
  return (
    <CatalogFilters
      candidates={candidates}
      context={context}
      filter={filter}
      setFilter={setFilter}
    />
  );
}
function button(name: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name,
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(initial?: Filter | CatalogQuery) {
  await root.rerender(<Fixture initial={initial} />);
}
beforeEach(async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  host.remove();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

it.each([
  { theme: "dark", width: 1600 },
  { theme: "light", width: 1600 },
  { theme: "dark", width: 390 },
  { theme: "light", width: 390 },
])("keeps $theme facet options compact and wrapping at $width", async ({ theme, width }) => {
  await page.viewport(width, 1000);
  document.documentElement.dataset.theme = theme;
  await render();
  await click("Filters (0)");
  await page.getByText("Advanced filters", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Filter options", exact: true });
  const options = [...panel.element().querySelectorAll<HTMLButtonElement>("fieldset button")];
  expect(options.length).toBeGreaterThan(20);
  for (const option of options) {
    expect(option.getBoundingClientRect().height).toBeLessThanOrEqual(48);
    expect(option.scrollWidth).toBeLessThanOrEqual(option.clientWidth + 1);
  }
  await click("Windows (2)");
  await click("Preview (1)");
  expect(current).toMatchObject({ platforms: ["windows-x86-64"], channels: ["beta"] });
  await expect
    .element(
      page
        .getByRole("group", { name: "Target OS", exact: true })
        .getByRole("button", { name: /^Windows/ }),
    )
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(
      page
        .getByRole("group", { name: "Release channels", exact: true })
        .getByRole("button", { name: /^Preview/ }),
    )
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Filters (2)", exact: true }))
    .toHaveFocus();
  await expect.element(panel).not.toBeInTheDocument();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
});
it("starts with ordinary filters and exposes technical groups on request", async () => {
  await render();
  await click("Filters (0)");
  await expect.element(page.getByRole("group", { name: "Target OS", exact: true })).toBeVisible();
  expect(
    document.querySelector<HTMLDetailsElement>('[aria-label="Filter options"] details')?.open,
  ).toBe(false);
  await page.getByText("Advanced filters", { exact: true }).click();
  await expect
    .element(page.getByRole("group", { name: "Setup methods", exact: true }))
    .toBeVisible();
});
it("uses one inline panel and returns focus from Escape and Done without clearing search", async () => {
  await render();
  await act(async () => setQuery("Both"));
  const trigger = page.getByRole("button", { name: "Filters (0)", exact: true });
  await trigger.click();
  expect(document.querySelectorAll('[aria-label="Filter options"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await expect
    .element(page.getByRole("heading", { name: "Discover filters", exact: true }))
    .toHaveFocus();
  await expect
    .element(page.getByRole("group", { name: "Original system", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("group", { name: "Target OS", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Windows (1)", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Filters (1)", exact: true }))
    .toHaveFocus();
  expect(document.querySelector('[aria-label="Filter options"]')).toBeNull();
  expect(currentSearch).toBe("Both");
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Filters (1)", exact: true }))
    .toHaveFocus();
  expect(document.querySelector('[aria-label="Filter options"]')).toBeNull();
  await page.getByRole("button", { name: "Remove Windows filter", exact: true }).click();
  await expect.element(trigger).toHaveFocus();
  expect(currentSearch).toBe("Both");
});
it("keeps advanced choices open and focus visible after clearing their last selection", async () => {
  await render({ version: 1, installationMethods: ["portable-package"] });
  await act(async () => setContext(retainedContext(new Map())));
  await click("Filters (1)");
  const choice = page.getByRole("button", { name: "Portable upstream package (3)", exact: true });
  await choice.click();
  expect(
    document.querySelector<HTMLDetailsElement>('[aria-label="Filter options"] details')?.open,
  ).toBe(true);
  await expect.element(choice).toHaveFocus();
  await expect.element(choice).toBeVisible();
});
it("uses distinct self-excluding counts and functional OR/AND selections", async () => {
  await render();
  await click("Filters (0)");
  await click("Windows (2)");
  expect(button("Preview (1)").getAttribute("aria-pressed")).toBe("false");
  await click("Preview (1)");
  expect(filterPorts(ports, new Map(), "catalog", current, "").map((port) => port.id)).toEqual([
    "both",
  ]);
  expect(button("Linux (2)")).toBeDefined();
  await click("Linux (2)");
  expect(filterPorts(ports, new Map(), "catalog", current, "").map((port) => port.id)).toEqual([
    "linux",
    "both",
  ]);
  await act(async () => {
    button("Stable (2)").click();
    button("Stable (2)").click();
  });
  expect((current as CatalogQuery).channels).toEqual(["beta"]);
  await act(async () => setFavoritesOnly(true));
  expect(button("Windows (1)")).toBeDefined();
  expect(button("Linux (1)")).toBeDefined();
  await act(async () => setQuery("no matching title"));
  expect(button("Windows (0)").disabled).toBe(false);
  expect(button("Preview (0)").disabled).toBe(false);
  await click("Preview (0)");
  expect((current as CatalogQuery).channels).toEqual([]);
});
it("keeps zero selections removable and returns focused chip to the trigger", async () => {
  await render({ version: 1, platforms: ["macos-aarch64"] });
  const chip = button("Remove Apple silicon filter");
  chip.focus();
  await act(async () => {
    chip.click();
    chip.click();
  });
  expect(document.activeElement).toBe(button("Filters (0)"));
  await click("Filters (0)");
  await click("Apple silicon (0)");
  expect(button("Apple silicon (0)").getAttribute("aria-pressed")).toBe("true");
  await click("Apple silicon (0)");
  expect((current as CatalogQuery).platforms).toEqual([]);
});
it.each([
  { version: 2, platforms: ["windows-x86-64"] },
  { version: 1, platforms: 42 },
  { version: 1, channels: ["future"] },
])("holds restored query %j until explicit reset", async (initial) => {
  await render(initial as unknown as CatalogQuery);
  await click("Filters (0)");
  expect(button("Windows (unavailable)").disabled).toBe(true);
  expect(current).toEqual(initial);
  await click("Clear filters");
  expect(current).toBe("all");
  expect(button("Windows (2)").disabled).toBe(false);
});
it("preserves established extra predicates visibly on edit and clears only query on reset", async () => {
  const method = "portable-package";
  for (const port of ports)
    port.presentation = { installation_method: method } as NonNullable<typeof port.presentation>;
  await render({ version: 1, installationMethods: [method] });
  await click("Filters (1)");
  expect(button("Portable upstream package (3)").getAttribute("aria-pressed")).toBe("true");
  await click("Windows (2)");
  expect((current as CatalogQuery).installationMethods).toEqual([method]);
  await act(async () => {
    setQuery("Both");
    setFavoritesOnly(true);
  });
  await click("Clear filters");
  expect(currentSearch).toBe("Both");
  expect(button("Windows (1)")).toBeDefined();
  expect(button("Linux (1)")).toBeDefined();
});

it("keeps selections editable when candidate facts are unavailable instead of claiming zero counts", async () => {
  await root.rerender(
    <CatalogFilters
      view="library"
      filter={{ version: 1, platforms: ["linux-x86-64"] }}
      setFilter={vi.fn()}
    />,
  );
  await click("Filters (1)");
  expect(button("Linux (unavailable)").disabled).toBe(false);
  expect(button("Linux (unavailable)").getAttribute("aria-pressed")).toBe("true");
  await page.getByText("Advanced filters", { exact: true }).click();
  await expect
    .element(page.getByRole("group", { name: "Installation attention", exact: true }))
    .toBeVisible();
  const attention = [...document.querySelectorAll("fieldset")].find(
    (group) => group.querySelector("legend")?.textContent === "Installation attention",
  );
  expect(attention?.textContent).toContain("Unavailable details remain unknown");
  expect(button("Remove Linux filter")).toBeDefined();
});

const install = (port_id: string) => ({
  id: `${port_id}-active`,
  port_id,
  version: "1",
  path: "/fixture",
  channel: "stable" as const,
  installed_at: 1,
  verified: true,
  staged: false,
  artifact: { asset_name: "fixture.zip", sha256: "a".repeat(64), size: 1 },
  manifest_sha256: "b".repeat(64),
  selected_executable: "game.exe",
  runtime: null,
});
const membershipContext: CatalogQueryContext = {
  library: {
    id: "selected",
    statuses: new Map([
      ["windows", { ...portStatus(), port_id: "windows", active: install("windows") }],
      [
        "linux",
        { ...portStatus(), port_id: "linux", staged: { ...install("linux"), staged: true } },
      ],
      [
        "both",
        {
          ...portStatus(),
          port_id: "both",
          external_runtime: {
            id: "external",
            port_id: "both",
            path: "/fixture",
            executable: "game.exe",
            platform: "windows-x86-64" as const,
            version: "1",
            registered_at: 1,
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
          },
        },
      ],
    ]),
  },
};
membershipContext.browsing = retainedContext(membershipContext.library!.statuses).browsing;
it("composes managed/external membership with declarations and keeps zero options removable", async () => {
  await render();
  await act(async () => setContext(membershipContext));
  await click("Filters (0)");
  await click("In my library (2)");
  await click("Windows (2)");
  expect(button("Not in my library (0)").disabled).toBe(false);
  await click("Not in my library (0)");
  expect((current as CatalogQuery).membership).toEqual(["in-library", "not-in-library"]);
  await click("In my library (2)");
  expect(
    filterPorts(ports, new Map(), "catalog", current, "", "catalog", membershipContext),
  ).toEqual([]);
  await click("Remove Not in my library filter");
  expect((current as CatalogQuery).platforms).toEqual(["windows-x86-64"]);
  expect((current as CatalogQuery).membership).toEqual([]);
  await click("Linux (2)");
  await click("In my library (2)");
  expect(
    filterPorts(ports, new Map(), "catalog", current, "", "catalog", membershipContext).map(
      (p) => p.id,
    ),
  ).toEqual(["windows", "both"]);
});
it("retains removable membership intent through unavailable and confirmed-empty context", async () => {
  await render({ version: 1, membership: ["not-in-library"] });
  await click("Filters (1)");
  expect(button("Not in my library (unavailable)").disabled).toBe(true);
  expect(button("Not in my library (unavailable)").getAttribute("aria-pressed")).toBe("true");
  expect(button("Remove Not in my library filter")).toBeDefined();
  await act(async () => setContext({ library: { id: "empty", statuses: new Map() } }));
  expect(button("Not in my library (3)").disabled).toBe(false);
  expect(button("In my library (0)")).toBeDefined();
  await act(async () => setContext(undefined));
  await click("Remove Not in my library filter");
  expect((current as CatalogQuery).membership).toEqual([]);
  expect(button("In my library (unavailable)").disabled).toBe(true);
  expect(button("Windows (2)").disabled).toBe(false);
});

it("composes observed installation attention and keeps zero/unavailable reasons removable", async () => {
  const statuses = new Map(membershipContext.library!.statuses);
  statuses.set("windows", {
    ...statuses.get("windows")!,
    readiness: {
      launchable: false,
      pending_setup: false,
      blockers: ["missing_source", "missing_bios"],
    },
  });
  statuses.set("both", {
    ...statuses.get("both")!,
    active: { ...install("both"), channel: "beta" },
    readiness: { launchable: true, pending_setup: true, blockers: [] },
  });
  const context = retainedContext(statuses);
  await render();
  await act(async () => setContext(context));
  await click("Filters (0)");
  await click("Missing game files (1)");
  await click("Finish setup (1)");
  await click("Preview (1)");
  expect(
    filterPorts(ports, statuses, "catalog", current, "", "catalog", context).map((p) => p.id),
  ).toEqual(["both"]);
  expect(button("Missing game files (0)").disabled).toBe(false);
  await click("Finish setup (1)");
  expect(filterPorts(ports, statuses, "catalog", current, "", "catalog", context)).toEqual([]);
  expect(button("Missing game files (0)").getAttribute("aria-pressed")).toBe("true");
  await act(async () => setContext(undefined));
  expect(button("Missing game files (unavailable)").disabled).toBe(true);
  await click("Remove Missing game files filter");
  expect(current).toMatchObject({ attention: [], channels: ["beta"] });
  expect(button("Preview (2)").disabled).toBe(false);
  await act(async () => setContext({ library: { id: "empty", statuses: new Map() } }));
  expect(button("Repair needed (unavailable)").disabled).toBe(true);
});
it("keeps unknown restored attention unresolved until reset", async () => {
  await render({ version: 1, attention: ["future-reason"] });
  await act(async () => setContext(membershipContext));
  await click("Filters (0)");
  expect(button("Missing BIOS (unavailable)").disabled).toBe(true);
  expect(current).toMatchObject({ attention: ["future-reason"] });
  await click("Clear filters");
  expect(current).toBe("all");
});

it("composes observed update choices and removes retained zero/unavailable selections", async () => {
  const statuses = new Map(membershipContext.library!.statuses);
  for (const id of ["windows", "both"]) {
    const active = install(id);
    const candidate = {
      ...active,
      id: "candidate",
      version: "2",
      staged: true,
      artifact: { ...active.artifact, sha256: "d".repeat(64) },
    };
    statuses.set(id, {
      ...portStatus(),
      port_id: id,
      active,
      staged: id === "windows" ? candidate : null,
      last_update_check: {
        checked_at: 10,
        check: {
          port_id: id,
          channel: "stable",
          installed_version: active.version,
          installed_artifact: { ...active.artifact },
          installed_runtime: null,
          required_runtime: null,
          update_available: true,
          release: {
            version: "2",
            channel: "stable",
            published_at: null,
            asset: {
              name: candidate.artifact.asset_name,
              sha256: candidate.artifact.sha256,
              size: candidate.artifact.size,
              url: "https://example.com/game.zip",
            },
          },
        },
      },
    });
  }
  const preview = statuses.get("both")!;
  statuses.set("both", {
    ...preview,
    channel: "beta",
    active: { ...preview.active!, channel: "beta" },
    last_update_check: {
      ...preview.last_update_check!,
      check: {
        ...preview.last_update_check!.check,
        channel: "beta",
        release: { ...preview.last_update_check!.check.release, channel: "beta" },
      },
    },
  });
  const context = retainedContext(statuses);
  await render();
  await act(async () => setContext(context));
  await click("Filters (0)");
  await click("Matching update staged (1)");
  await click("Available at last check (1)");
  await click("Preview (1)");
  expect(
    filterPorts(ports, statuses, "catalog", current, "", "catalog", context).map((p) => p.id),
  ).toEqual(["both"]);
  expect(button("Matching update staged (0)").getAttribute("aria-pressed")).toBe("true");
  await click("Available at last check (1)");
  expect(filterPorts(ports, statuses, "catalog", current, "", "catalog", context)).toEqual([]);
  await act(async () => setContext(undefined));
  expect(button("Matching update staged (unavailable)").disabled).toBe(true);
  await click("Remove Matching update staged filter");
  expect(current).toMatchObject({ updates: [], channels: ["beta"] });
  await act(async () => setContext({ library: { id: "empty", statuses: new Map() } }));
  expect(button("Available at last check (unavailable)").disabled).toBe(true);
});
it("retains unsupported restored update values until reset", async () => {
  await render({ version: 1, updates: ["future-candidate"] });
  await click("Filters (0)");
  expect(button("Matching update staged (unavailable)").disabled).toBe(true);
  expect(current).toMatchObject({ updates: ["future-candidate"] });
  await click("Clear filters");
  expect(current).toBe("all");
});
