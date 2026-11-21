import { DirectionProvider } from "@base-ui/react/direction-provider";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { PortBrowser } from "../components/PortBrowser";
import { DetailLayout } from "../components/DetailLayout";
import { ListingDetailPanel } from "../components/ListingDetailPanel";
import { catalogEntries } from "../features/browsing/catalog-entry";
import type { CatalogQuery } from "../features/browsing/catalog-query";
import { portDefinition, portStatus } from "../test-fixtures";
import type { PortListing, PortStatus } from "../types";
import { filterPorts } from "../view-model";
import { browsingContextFixture } from "./browsing-context-fixture";
import { discoverGroupForPort } from "./discover-test-helpers";
import "../styles/index.css";

const invoke = vi.hoisted(() => vi.fn(async () => null));
const modSetups = vi.hoisted(() => vi.fn(async () => {
  throw new Error("No reviewed mod source for this listing");
}));
vi.mock("../api", () => ({
  desktopApi: new Proxy({ modSetups }, { get: (target, key) => Reflect.get(target, key) ?? invoke }),
}));

afterEach(cleanup);

// A Windows-managed port whose accepted listing also offers a Linux upstream download.
const listing: PortListing = {
  id: "arcade-recomp",
  name: "Arcade Recomp",
  summary: "A recompilation with a managed Windows integration.",
  project_url: "https://example.com/arcade-recomp",
  original_game_title: "Arcade Game",
  platforms: ["linux-x86-64"],
  availability: "packages",
};
const [entry] = catalogEntries(
  {
    schema_version: 1,
    source_profiles: [],
    ports: [
      {
        ...portDefinition(),
        id: listing.id,
        name: listing.name,
        platforms: ["windows-x86-64"],
        channels: ["stable"],
      },
    ],
  },
  { format_version: 1, listings: [listing] },
  [],
  [],
);
const ports = [entry!];
const statuses = new Map<string, PortStatus>();

function linuxLibrary() {
  const context = browsingContextFixture([entry!.definition!], statuses, "/listing-platforms");
  context.browsing = { ...context.browsing!, host_platform: "linux-x86-64" };
  context.devicePlatform = "linux-x86-64";
  return context;
}

async function renderCatalog(filter: CatalogQuery) {
  const context = linuxLibrary();
  await render(
    <DirectionProvider direction="ltr">
      <main>
        <PortBrowser
          view="catalog"
          ports={filterPorts(ports, statuses, "catalog", filter, "", "catalog", context)}
          catalogFilterCandidates={filterPorts(ports, statuses, "catalog", "all", "")}
          queryContext={context}
          statuses={statuses}
          libraryCount={0}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter={filter}
          setFilter={() => {}}
          onSelect={() => {}}
          loading={false}
        />
      </main>
    </DirectionProvider>,
  );
}

it("finds a Windows-managed port under the Linux filter its listing download covers", async () => {
  await renderCatalog({ version: 1, platforms: ["linux-x86-64"] });
  const group = discoverGroupForPort(listing.id);
  expect(group.textContent).toContain(listing.name);
  expect(group.textContent).not.toContain("Not available for Linux");
  await renderCatalog({ version: 1, platforms: ["this-device"] });
  expect(discoverGroupForPort(listing.id).textContent).not.toContain("Not available for");
});

it("leaves the port out of a platform neither the definition nor the listing offers", async () => {
  await renderCatalog({ version: 1, platforms: ["macos-aarch64"] });
  expect(document.querySelector(`[data-discover-port-ids*="${listing.id}"]`)).toBeNull();
});

it("visibly qualifies the upstream Linux target beside the Windows setup in the detail hero", async () => {
  await render(
    <DetailLayout
      port={entry!}
      upstreamPlatforms={listing.platforms}
      initialSection="overview"
      readiness="Not installed"
      installation="Managed installation"
      close={vi.fn()}
      action={() => null}
    >
      {() => ({ overview: null, files: null, saves: null, versions: null })}
    </DetailLayout>,
  );
  await expect.element(page.getByText("Windows", { exact: true }).first()).toBeVisible();
  await expect.element(page.getByText("Linux · Upstream", { exact: true }).first()).toBeVisible();
});

it("labels both architectures when managed Intel and upstream Apple silicon share an OS", async () => {
  await render(
    <DetailLayout
      port={entry!}
      platforms={["macos-x86-64"]}
      upstreamPlatforms={["macos-aarch64"]}
      initialSection="overview"
      readiness="Not installed"
      installation="Managed installation"
      close={vi.fn()}
      action={() => null}
    >
      {() => ({ overview: null, files: null, saves: null, versions: null })}
    </DetailLayout>,
  );
  await expect.element(page.getByText("macOS Intel", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Apple silicon · Upstream", { exact: true })).toBeVisible();
  expect(page.getByText("macOS", { exact: true }).query()).toBeNull();
});

it.each([false, true])(
  "keeps the listing platform separate from a registered runtime (registered %s)",
  async (registered) => {
    const [listingEntry] = catalogEntries(
      undefined,
      { format_version: 1, listings: [listing] },
      [],
      [],
    );
    const status: PortStatus = {
      ...portStatus(),
      port_id: listing.id,
      external_runtime: registered
        ? {
            id: "registered-1",
            port_id: listing.id,
            path: "C:/Player/Runtime",
            executable: "C:/Player/Runtime/game.exe",
            version: "1.0",
            platform: "windows-x86-64",
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            registered_at: 1,
          }
        : null,
    };
    await render(
      <ListingDetailPanel
        entry={listingEntry!}
        status={status}
        generation={1}
        perform={vi.fn()}
        onChanged={vi.fn()}
        close={vi.fn()}
      />,
    );
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect.element(page.getByText("Linux · Upstream", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Upstream project platforms", { exact: true }))
      .toBeVisible();
    expect(
      page.getByText("Recorded installation platforms", { exact: true }).query() !== null,
    ).toBe(registered);
    expect(
      document.querySelector(".detail-identity-chips [title='Runs on']")?.textContent?.trim(),
    ).toBe(registered ? "Windows" : undefined);
  },
);
