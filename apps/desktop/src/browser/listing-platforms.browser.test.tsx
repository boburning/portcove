import { DirectionProvider } from "@base-ui/react/direction-provider";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { PortBrowser } from "../components/PortBrowser";
import { DetailLayout } from "../components/DetailLayout";
import { catalogEntries } from "../features/browsing/catalog-entry";
import type { CatalogQuery } from "../features/browsing/catalog-query";
import { portDefinition } from "../test-fixtures";
import type { PortListing, PortStatus } from "../types";
import { filterPorts } from "../view-model";
import { browsingContextFixture } from "./browsing-context-fixture";
import { discoverGroupForPort } from "./discover-test-helpers";
import "../styles/index.css";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../api", () => ({ desktopApi: new Proxy({}, { get: () => invoke }) }));

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

it("shows the listing's Linux download beside the managed Windows platform in the detail hero", async () => {
  await render(
    <DetailLayout
      port={entry!}
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
  await expect.element(page.getByText("Linux", { exact: true }).first()).toBeVisible();
});
