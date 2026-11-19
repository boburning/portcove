import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../../App";
import { browserFixture } from "../../../test/browser-fixture";
import { desktopApi } from "../../api";
import { installInteractiveTransport } from "../../dev-scenarios/interactive/transport";
import { workspace } from "../../dev-scenarios/interactive/scenarios";
import { initializeLocalization, LocalizationProvider } from "../../localization";
import "../../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({ viewport: true });
  localStorage.clear();
});
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.getElementById("root")?.remove();
  await fixture.dispose();
});

function installSiblingListingFixture() {
  const snapshot = workspace("details");
  const ids = ["details-unknown", "details-downloaded"];
  snapshot.listing_catalog!.listings = snapshot
    .listing_catalog!.listings.filter((listing) => ids.includes(listing.id))
    .map((listing, index) => ({
      ...listing,
      name: index ? "Native project Beta" : "Native project Alpha",
      original_game_title: "Original fixture game",
      original_game: {
        format_version: 1,
        id: "original-fixture-game",
        evidence_urls: ["https://example.com/fixture"],
        source_editions: [
          {
            id: `edition-${index}`,
            title: `Independent source edition ${index}`,
            evidence_urls: ["https://example.com/fixture"],
          },
        ],
      },
    }));
  snapshot.pending_setups = [];
  for (const status of snapshot.statuses.filter((status) => ids.includes(status.port_id))) {
    status.external_runtime = null;
    status.readiness = { launchable: false, blockers: [], pending_setup: false };
  }
  for (const row of (snapshot.listing_statuses ?? []).filter((row) => ids.includes(row.port_id))) {
    row.status = snapshot.statuses.find((status) => status.port_id === row.port_id)!;
    row.actions = [
      { action: "attach-existing", allowed: true },
      { action: "launch", allowed: false },
    ];
  }
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "catalogDownloadCandidates").mockImplementation(async (portId) => ({
    port_id: portId,
    allowed: false,
    releases: [],
    selected_release_id: null,
    recommended_asset_id: null,
    packages: [],
    recommendation_reason: "No recommendation in this controlled fixture",
    candidates: [],
    coverage: {
      release_limit: 10,
      candidate_limit: 200,
      releases_checked: 0,
      release_history_complete: true,
      candidates_complete: true,
    },
    default_destination_parent: null,
    upstream_url: "https://example.com/fixture/releases",
    reason: "No packages in this controlled fixture",
  }));
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  transport = installInteractiveTransport("details", (message) => {
    throw Error(message);
  });
  return { ids, root };
}

it.each([1366, 414])(
  "keeps deliberate choice and alternatives in the actual uninstalled listing detail route at %ipx",
  async (width) => {
    await page.viewport(width, 900);
    const { root } = installSiblingListingFixture();
    const write = vi.spyOn(desktopApi, "changeOrganization");
    initializeLocalization(["en"]);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
      { container: root },
    );
    if (width < 960)
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Discover", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await page.getByRole("textbox", { name: "Search Discover" }).fill("Original fixture game");
    await page.getByRole("button", { name: "Compare ports", exact: true }).click();
    await page.getByRole("button", { name: "Choose Native project Beta", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Original fixture game", exact: true }))
      .toBeVisible();
    const alternatives = page.getByText("Other ports for this game (2)", { exact: true });
    await expect.element(alternatives).toBeVisible();
    await alternatives.click();
    await expect
      .element(page.getByRole("button", { name: "Preferred: Native project Beta", exact: true }))
      .toBeVisible();
    expect(write).toHaveBeenCalledWith(
      0,
      {
        kind: "set_preferred_implementation",
        game_id: "original-fixture-game",
        port_id: "details-downloaded",
      },
      1,
    );
    await page.getByRole("button", { name: "View Native project Alpha", exact: true }).click();
    await page.getByText("Other ports for this game (2)", { exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Preferred: Native project Beta", exact: true }))
      .toBeVisible();
    expect(write).toHaveBeenCalledTimes(1);
    await expect
      .element(page.getByRole("button", { name: "Use an existing installation", exact: true }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Back to Discover", exact: true }).click();
    await expect
      .poll(() => document.activeElement?.getAttribute("data-detail-game-id"))
      .toBe("details-downloaded");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("heading", { name: "Original fixture game", exact: true }))
      .toBeVisible();
  },
);

it("removes a filtered sibling Favorite through listing details and rereads it on remount", async () => {
  await page.viewport(1366, 900);
  const { ids, root } = installSiblingListingFixture();
  const favoritePorts = new Set([ids[1]!, "unknown-port"]);
  vi.spyOn(desktopApi, "favoritePorts").mockImplementation(async () => [...favoritePorts]);
  const setPortFavorite = vi
    .spyOn(desktopApi, "setPortFavorite")
    .mockImplementation(async (portId, favorite) => {
      if (favorite) favoritePorts.add(portId);
      else favoritePorts.delete(portId);
    });
  initializeLocalization(["en"]);
  const app = await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect.element(page.getByRole("button", { name: "Discover", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search Discover" });
  await search.fill("Native project Alpha");
  const favorite = page.getByRole("button", {
    name: "Favorite Original fixture game",
    exact: true,
  });
  await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Favorites 1 game", exact: true }).click();
  await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
  await search.fill("Original fixture game");
  await page.getByRole("button", { name: "Compare ports", exact: true }).click();
  const comparison = page.getByRole("dialog");
  await expect
    .element(
      comparison.getByRole("button", { name: "Favorite Original fixture game", exact: true }),
    )
    .toHaveAttribute("aria-pressed", "true");
  const alpha = comparison.getByRole("button", { name: /View port: .*Native project Alpha/ });
  await alpha.click();
  await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector("[data-detail-port-id]")?.getAttribute("data-detail-port-id")).toBe(
    ids[0],
  );
  await favorite.click();
  await expect.element(favorite).toHaveAttribute("aria-pressed", "false");
  expect(setPortFavorite).toHaveBeenCalledExactlyOnceWith(ids[1], false, 1);
  expect([...favoritePorts]).toEqual(["unknown-port"]);
  await expect
    .element(page.getByRole("button", { name: "Use an existing installation", exact: true }))
    .toBeEnabled();
  await app.rerender(
    <LocalizationProvider api={desktopApi}>
      <App key="reloaded" />
    </LocalizationProvider>,
  );
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await search.fill("Native project Alpha");
  await expect.element(favorite).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(page.getByRole("button", { name: "Favorites 0 games", exact: true }))
    .toBeVisible();
});

it.each([true, false])(
  "opens the existing-installation editor once from managed detail with promotion %s",
  async (promoted) => {
    await page.viewport(1366, 900);
    const snapshot = workspace("details");
    const listing = snapshot.listing_catalog!.listings.find(
      ({ id }) => id === "details-downloaded",
    )!;
    const title = listing.original_game_title ?? listing.name;
    const definition = {
      ...snapshot.catalog.ports[0]!,
      id: listing.id,
      name: listing.name,
      presentation: {
        ...snapshot.catalog.ports[0]!.presentation!,
        original_game_title: title,
      },
    };
    const status = snapshot.statuses.find(({ port_id }) => port_id === listing.id)!;
    status.port_actions = [
      promoted
        ? {
            action: "install",
            availability: "held",
            reason: "definition_ineligible",
            definition: { outcome: "hold", reason: "authenticated_integrity_required" },
          }
        : { action: "install", availability: "waiting", reason: "missing_source" },
    ];
    const assessment = snapshot.listing_statuses!.find(({ port_id }) => port_id === listing.id)!;
    snapshot.catalog.ports = [definition];
    snapshot.listing_catalog!.listings = [listing];
    snapshot.statuses = [status];
    snapshot.listing_statuses = [{ ...assessment, status }];
    snapshot.pending_setups = [];
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    vi.spyOn(desktopApi, "catalogDownloadCandidates").mockRejectedValue(
      new Error("No packages in this controlled fixture"),
    );
    transport = installInteractiveTransport("details", (message) => {
      throw Error(message);
    });
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    initializeLocalization(["en"]);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
      { container: root },
    );
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await page.getByRole("textbox", { name: "Search Discover" }).fill(title);
    const card = () => document.querySelector(`button[data-detail-game-id="${listing.id}"]`);
    await expect.poll(() => card()?.checkVisibility()).toBe(true);
    await page.elementLocator(card()!).click();
    const overview = page.getByRole("tab", { name: "Overview", exact: true });
    const editor = page.getByRole("heading", { name: "Launch details", exact: true });
    const editorInAnyPanel = page.getByText("Launch details", { exact: true });
    await expect.element(overview).toBeVisible();
    await expect.element(editorInAnyPanel).not.toBeInTheDocument();
    await overview.click();
    const entry = page.getByRole("button", { name: "Use an existing installation", exact: true });
    await expect.poll(() => entry.query()?.checkVisibility() ?? false).toBe(promoted);
    if (!promoted) await page.getByRole("tab", { name: "Game files", exact: true }).click();
    await expect.element(editorInAnyPanel).not.toBeInTheDocument();
    await entry.click();
    await expect
      .element(page.getByRole("tab", { name: "Game files", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(editor).toHaveFocus();
    await expect
      .element(page.getByRole("heading", { name: "Use your existing installation", exact: true }))
      .toBeVisible();
    await expect.element(entry).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByText("Download another version", { exact: true }))
      .not.toBeInTheDocument();
  },
);
