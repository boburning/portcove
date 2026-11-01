import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../../App";
import { desktopApi } from "../../api";
import { installInteractiveTransport } from "../../dev-scenarios/interactive/transport";
import { workspace } from "../../dev-scenarios/interactive/scenarios";
import { initializeLocalization, LocalizationProvider } from "../../localization";
import "../../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.getElementById("root")?.remove();
});

it("keeps deliberate choice and alternatives in the actual uninstalled listing detail route", async () => {
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
  const write = vi.spyOn(desktopApi, "changeOrganization");
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("textbox", { name: "Search Discover" }).fill("Original fixture game");
  await page.getByRole("button", { name: "Compare ports", exact: true }).click();
  await page.getByRole("button", { name: "Use Native project Beta", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Original fixture game", exact: true }))
    .toBeVisible();
  const alternatives = page.getByText("Implementations (2)", { exact: true });
  await expect.element(alternatives).toBeVisible();
  await alternatives.click();
  await expect
    .element(page.getByRole("button", { name: "Chosen: Native project Beta", exact: true }))
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
  await page.getByText("Implementations (2)", { exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Chosen: Native project Beta", exact: true }))
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
});
