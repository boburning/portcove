import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { emptyModDraft } from "../features/mod-setups/mod-draft";
import type {
  ModSetupView,
  ProviderCatalog,
  ProviderInstallPlan,
  ProviderProjectView,
  ProviderUpdateObservation,
} from "../types";
import { mergeCatalogReads, ModProviderBrowser } from "./ModProviderBrowser";
import { PortBrowser } from "./PortBrowser";
import { portDefinition } from "../test-fixtures";
import type { ModUpdateControlProps } from "./ModUpdateControl";
import "../styles/index.css";

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  for (const key of ["layout", "installation", "sort.gamebanana", "sort.thunderstore"]) {
    localStorage.removeItem(`portcove.mods.${key}`);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await page.viewport(1280, 720);
});

function mod(id: string, name: string, provider = "gamebanana"): ProviderProjectView["project"] {
  return {
    provider,
    project_id: id,
    name,
    version: "2.0",
    game_id: "16121",
    updated_at: 5,
    obsolete: false,
    profile_url: "https://gamebanana.com/mods/42",
    submitter: null,
    files: [],
    unreadable_files: 0,
    listing: {
      artwork: null,
      categories: ["Textures"],
      created_at: null,
      downloads: null,
      likes: null,
      ratings: null,
    },
  };
}

const catalog = (
  projects = [mod("42", "HD Link")],
  freshness: ProviderCatalog["freshness"] = "fresh",
) => ({
  projects,
  complete: true,
  legacy_game_id: "16121",
  observed_at: 1800000000,
  freshness,
});

const project = (freshness = "fresh") =>
  ({
    port_id: "shipwright",
    game_name: "Ship of Harkinian",
    project: {
      ...mod("42", "HD Link"),
      files: [
        {
          file_id: "10",
          file_name: "pack.zip",
          size: 4096,
          added_at: 4,
          download_url: "",
          claimed_md5: null,
          archived: false,
          claimed_scan: "clean",
        },
      ],
      unreadable_files: 0,
    },
    eligible_file_ids: ["10"],
    observed_at: 0,
    freshness,
  }) as unknown as ProviderProjectView;

const plan = {
  port_id: "shipwright",
  profile_id: "default",
  expected_revision: 1,
  provider: { provider: "gamebanana", project: "42", file: "10" },
  project_name: "HD Link",
  file: { file_id: "10", file_name: "pack.zip" },
  download_size: 4096,
  download_sha256: "c".repeat(64),
  ignored_entries: 1,
  conflicts_truncated: false,
  members: [{ file_name: "hd-link.o2r", sha256: "a".repeat(64), size: 2048, asset_count: 1 }],
  replaces: ["HD Link.otr"],
  conflicts: [],
  unverified_claims: ["GameBanana's MD5"],
  plan_sha256: "b".repeat(64),
} as unknown as ProviderInstallPlan;

async function render(
  options: {
    browsing?: boolean;
    sources?: string[];
    packages?: ModSetupView["revision"]["packages"];
    updates?: Pick<ModUpdateControlProps, "policy" | "setPolicy" | "automaticChecks">;
    onInstalled?: (message: string) => void;
  } = {},
) {
  vi.spyOn(desktopApi, "previewModSetupDraft").mockResolvedValue({
    order: [],
    conflicts: [],
    conflicts_truncated: false,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const selected = {
    profile: { id: "default", current_revision: 1, display_name: "Default" },
    revision: { packages: options.packages ?? [] },
  } as unknown as ModSetupView;
  const onBusyChange = vi.fn();
  const onInstalled = options.onInstalled ?? vi.fn();
  function TestBrowser() {
    const [draft, setDraft] = useState(emptyModDraft);
    const [browsing, setBrowsing] = useState(options.browsing ?? !options.updates);
    return (
      <ModProviderBrowser
        portId="shipwright"
        generation={7}
        selected={selected}
        sources={options.sources ?? ["gamebanana"]}
        browsing={browsing}
        onBrowse={() => setBrowsing(true)}
        disabled={false}
        draft={draft}
        setDraft={setDraft}
        onBusyChange={onBusyChange}
        onInstalled={onInstalled}
        {...(options.updates ? { updates: options.updates } : {})}
      />
    );
  }
  await act(async () => root.render(<TestBrowser />));
  return { host, root };
}

it("keeps the update check focused and announces results that fit a compact panel", async () => {
  let resolveCheck!: (observations: ProviderUpdateObservation[]) => void;
  const pending = new Promise<ProviderUpdateObservation[]>((resolve) => {
    resolveCheck = resolve;
  });
  const check = vi.spyOn(desktopApi, "checkProviderModUpdates").mockReturnValue(pending);
  const { host } = await render({
    updates: { policy: "review_updates", setPolicy: vi.fn(), automaticChecks: [] },
  });
  host.style.inlineSize = "430px";
  const trigger = page.getByRole("button", { name: "Check for mod updates" });
  const checking = page.getByRole("button", { name: "Checking for mod updates…" });
  await act(async () => trigger.click());
  await expect.element(checking).toHaveFocus();
  await expect.element(checking).toHaveAttribute("aria-busy", "true");
  await act(async () =>
    resolveCheck([
      {
        freshness: "fresh",
        installed_version: "1.0",
        native_id: "LongRegisteredModName".repeat(10) + ".o2r",
        newer_files: [],
        observed_version: "1.0",
        provider: { provider: "gamebanana", project: "42" },
        reason: null,
        state: "current",
        version_changed: false,
      },
    ]),
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("Mod update check results");
  await expect.element(page.getByRole("list", { name: "Mod update check results" })).toBeVisible();
  expect(host.scrollWidth).toBe(host.clientWidth);
  await expect.element(trigger).toHaveFocus();
  expect(check).toHaveBeenCalledExactlyOnceWith("shipwright", "default", 7);
});

it("filters the catalog before paging and preserves a filtered second page when switching layouts", async () => {
  const projects = Array.from({ length: 42 }, (_, index) =>
    mod(String(index), index < 20 ? `Applied ${index}` : `Texture ${index}`),
  );
  const read = vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(catalog(projects));
  const applied = projects.slice(0, 20).map((item) => ({
    native_id: `${item.project_id}.o2r`,
    enabled: false,
    provider: { provider: "gamebanana", project: item.project_id, file: "10" },
  })) as ModSetupView["revision"]["packages"];
  const { host } = await render({ packages: applied });
  const filters = page.getByRole("button", { name: /^Filters/ });
  await filters.click();
  await page.getByRole("radio", { name: "Hide installed" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect.element(filters).toHaveFocus();
  await expect.element(page.getByText("22 mods")).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("button", { name: "Rows" }).click();
  await expect.element(page.getByText("Page 2 of 2")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Texture 41/ })).toBeVisible();
  expect(read).toHaveBeenCalledExactlyOnceWith("shipwright", "gamebanana", 7);
  await page.getByRole("searchbox", { name: "Search mods" }).fill("Texture 41");
  await expect.element(page.getByText("1 mod")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect.element(page.getByText("22 mods")).toBeVisible();
  host.style.inlineSize = "320px";
  expect(host.scrollWidth).toBe(host.clientWidth);
});

it("continues a large catalog past its first bounded read and finds the 601st mod", async () => {
  const first = Array.from({ length: 600 }, (_, index) =>
    mod(String(index + 1), `Mod ${index + 1}`),
  );
  const read = vi
    .spyOn(desktopApi, "modProviderCatalog")
    .mockResolvedValueOnce({
      ...catalog(first),
      complete: false,
      next_page: 13,
      expected_total: 601,
    })
    .mockResolvedValueOnce({
      ...catalog([mod("601", "Deep match")]),
      complete: true,
      expected_total: 601,
    });
  await render();
  await page.getByRole("searchbox", { name: "Search mods" }).fill("Deep match");
  await expect.element(page.getByRole("button", { name: /Deep match/ })).toBeVisible();
  expect(read).toHaveBeenNthCalledWith(2, "shipwright", "gamebanana", 7, 13);
});

it("keeps a continued catalog partial when the provider total changes between reads", () => {
  const merged = mergeCatalogReads(
    { ...catalog([mod("1", "One")]), complete: false, next_page: 2, expected_total: 2 },
    { ...catalog([mod("2", "Two")]), complete: true, expected_total: 3 },
  );
  expect(merged.projects).toHaveLength(2);
  expect(merged.complete).toBe(false);
  expect(merged.next_page).toBeNull();
});

it("queues exact identities, undoes one addition and applies the remainder as a single draft", async () => {
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(
    catalog([mod("42", "HD Link"), mod("43", "HD Link")]),
  );
  vi.spyOn(desktopApi, "providerProject").mockImplementation(async (_port, id) => ({
    ...project(),
    project: { ...project().project, project_id: id },
  }));
  const prepare = vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(plan);
  const applied = vi
    .spyOn(desktopApi, "applyModSetupDraft")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModSetupDraft>>);
  await render();
  await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.element(page.getByText("2 pending changes")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).nth(1).click();
  await expect.element(page.getByText("1 pending change")).toBeVisible();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Check files" }).click();
  await page.getByRole("button", { name: "Apply changes" }).click();
  expect(prepare).toHaveBeenCalledExactlyOnceWith(
    "shipwright",
    "default",
    "42",
    "10",
    7,
    "gamebanana",
    "16121",
  );
  expect(applied).toHaveBeenCalledExactlyOnceWith(
    "shipwright",
    "default",
    1,
    [plan],
    { packages: [], order: null, local_files: [] },
    7,
    false,
  );
  await expect.element(page.getByText("1 pending change")).not.toBeInTheDocument();
});

it("discards private plans on cancel and keeps the queued selection", async () => {
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(catalog());
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(project());
  vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(plan);
  const discard = vi.spyOn(desktopApi, "discardProviderInstall").mockResolvedValue();
  await render();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Check files" }).click();
  await expect.element(page.getByRole("button", { name: "Apply changes" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(discard).toHaveBeenCalledExactlyOnceWith("shipwright", plan, 7);
  await expect.element(page.getByText("Pending addition", { exact: true })).toBeVisible();
});

it("does not mark the same project ID in another provider scope as installed", async () => {
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(catalog());
  await render({
    packages: [
      {
        native_id: "other.o2r",
        enabled: false,
        provider: {
          provider: "gamebanana",
          project: "42",
          binding: { provider: "gamebanana", game_id: 7 },
        },
      },
    ] as ModSetupView["revision"]["packages"],
  });
  await expect.element(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
});

it("offers a second same-port source and labels cached results and failed refreshes", async () => {
  const read = vi
    .spyOn(desktopApi, "modProviderCatalog")
    .mockImplementation(async (_port, source) =>
      source === "gamebanana"
        ? catalog([])
        : catalog([mod("TSEG-Too_Many_Torches", "Too_Many_Torches", "thunderstore")], "stale"),
    );
  await render({ sources: ["gamebanana", "thunderstore"] });
  expect(read).not.toHaveBeenCalled();
  await page.getByRole("combobox", { name: /Source/ }).click();
  await page.getByRole("option", { name: "GameBanana" }).click();
  const search = page.getByRole("searchbox", { name: "Search mods" });
  await search.fill("Too Many Torches");
  await page.getByRole("button", { name: "Browse Thunderstore" }).click();
  await expect.element(search).toHaveValue("Too Many Torches");
  await expect
    .element(page.getByText("The source could not be reached. Showing saved results."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Too_Many_Torches" })).toBeVisible();
  read.mockRejectedValueOnce(new Error("Unavailable"));
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not refresh this source. Try again.");
  expect(read.mock.calls.map(([port, source]) => [port, source])).toEqual([
    ["shipwright", "gamebanana"],
    ["shipwright", "thunderstore"],
    ["shipwright", "thunderstore"],
  ]);
});

it.each(["unreadable", "unconfirmed", "multiple"] as const)(
  "opens the exact file chooser for a %s listing",
  async (listing) => {
    vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(catalog());
    const details = project();
    const other = { ...details.project.files[0]!, file_id: "11", file_name: "other.zip" };
    if (listing === "unreadable") {
      details.project.unreadable_files = 1;
    } else if (listing === "unconfirmed") {
      details.project.files.push({ ...other, status_unknown: "omitted" });
    } else {
      details.project.files.push(other);
      details.eligible_file_ids = ["10", "11"];
    }
    vi.spyOn(desktopApi, "providerProject").mockResolvedValue(details);
    await render();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const add = page.getByRole("button", { name: "Add pack.zip", exact: true });
    await expect.element(add).toBeVisible();
    await expect
      .element(page.getByText("Pending addition", { exact: true }))
      .not.toBeInTheDocument();
    const addOther = page.getByRole("button", { name: "Add other.zip", exact: true });
    await expect.poll(() => addOther.elements().length).toBe(listing === "multiple" ? 1 : 0);
    await add.click();
    await expect.element(page.getByText("1 pending change", { exact: true })).toBeVisible();
  },
);

it("rejects file choices observed for another port", async () => {
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(catalog());
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue({
    ...project(),
    port_id: "other-port",
  });
  await render();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(page.getByText("Pending addition", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Add pack.zip", exact: true }))
    .not.toBeInTheDocument();
});

it("shows a file with unconfirmed eligibility without offering Add", async () => {
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(catalog());
  const details = project();
  details.project.files[0]!.status_unknown = "omitted";
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(details);
  const planned = vi.spyOn(desktopApi, "planProviderInstall");
  await render();

  await page.getByRole("button", { name: /HD Link/ }).click();
  await expect.element(page.getByText("pack.zip", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/The provider did not confirm availability/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Add pack.zip/ })).not.toBeInTheDocument();
  expect(planned).not.toHaveBeenCalled();
});

it("offers Thunderstore's community link when the catalog exceeds Core's limits", async () => {
  const url = "https://thunderstore.io/c/zelda-64-recompiled/";
  vi.spyOn(desktopApi, "modProviderCatalog").mockRejectedValue({
    presentation: {
      summary: "The catalog is too large to load.",
      technical_message: "The community exceeds its package limit.",
      mutation_state: "read_only",
      technical_context: { provider_browse_url: url },
      recovery_actions: [],
    },
  });
  await render({ sources: ["thunderstore"] });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not refresh this source. Try again.");
  await expect
    .element(page.getByRole("link", { name: /Thunderstore/ }))
    .toHaveAttribute("href", url);
});

it("captures Discover and Browse mods at the same 833px and 320px widths", async () => {
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue(
    catalog([
      mod("42", "HD Link"),
      mod("43", "Sound effects"),
      mod("44", "Retro interface"),
      mod("45", "Original textures"),
    ]),
  );
  const { host } = await render();
  const search = page.getByRole("searchbox", { name: "Search mods" });
  const discover = document.createElement("div");
  document.body.append(discover);
  const root = createRoot(discover);
  mounted.push({ root, host: discover });
  function DiscoverFixture() {
    const [query, setQuery] = useState("link");
    const [layout, setCollectionLayout] = useState<"covers" | "rows">("covers");
    return (
      <PortBrowser
        view="catalog"
        ports={[portDefinition()]}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        libraryCount={0}
        filter="all"
        setFilter={() => {}}
        onSelect={() => {}}
        loading={false}
        query={query}
        setQuery={setQuery}
        catalogSort="catalog"
        setCatalogSort={() => {}}
        collectionLayout={layout}
        setCollectionLayout={setCollectionLayout}
      />
    );
  }
  await act(async () => root.render(<DiscoverFixture />));
  await search.fill("Link");
  for (const width of [833, 320]) {
    await page.viewport(width, 760);
    discover.style.inlineSize = host.style.inlineSize = `${width}px`;
    expect(host.scrollWidth).toBeLessThanOrEqual(width);
    const browse = host.querySelector<HTMLElement>(".mod-catalog")!;
    const discoverTools = discover.querySelector<HTMLElement>(".library-query-tools")!;
    await page.screenshot({
      element: browse,
      path: `../../../../outputs/mod-workspace-fixture/browse-${width}.png`,
    });
    await page.screenshot({
      element: discoverTools,
      path: `../../../../outputs/mod-workspace-fixture/discover-controls-${width}.png`,
    });
  }
});
