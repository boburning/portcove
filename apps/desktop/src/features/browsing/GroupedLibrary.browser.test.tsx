import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { LibraryOrganization, OrganizationChange } from "../../types";
import type { Organization } from "../organization/OrganizationControls";
import { GroupedLibrary } from "./GroupedLibrary";
import { GroupedDiscover } from "./GroupedDiscover";
import { desktopApi } from "../../api";
import { useOrganization } from "../organization/use-organization";
import { PortBrowser } from "../../components/PortBrowser";
import { install } from "../../dev-scenarios/interactive/scenarios";
import { browserFixture } from "../../../test/browser-fixture";
import "../../styles/index.css";

let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({ viewport: true, attributes: ["data-theme"], styles: ["zoom"] });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  await fixture.dispose();
});
const first = {
  ...portDefinition(),
  id: "first-port",
  name: "First project",
  presentation: {
    original_game_title: "Original game",
    original_game: {
      format_version: 1,
      id: "original-game",
      evidence_urls: [],
      source_editions: [],
    },
  },
};
const second = {
  ...first,
  id: "second-port",
  name: "Second project",
  presentation: first.presentation,
};
const empty: LibraryOrganization = {
  revision: 0,
  collections: {},
  followed_port_ids: [],
  followed_release_acknowledgments: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  update_notices: {},
  setup_confirmations: [],
};

it("requires an acknowledged choice, retains alternatives and targets the chosen stable port", async () => {
  const launch = vi.fn();
  const open = vi.fn();
  let accept!: (accepted: boolean) => void;
  const write = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      }),
  );
  function Fixture() {
    const [snapshot, setSnapshot] = useState(empty);
    const organization: Organization = {
      snapshot,
      busy: false,
      failure: undefined,
      refresh: async () => true,
      commit: async (change: OrganizationChange) => {
        const accepted = await write();
        if (accepted && change.kind === "set_preferred_implementation" && change.port_id)
          setSnapshot({
            ...snapshot,
            revision: snapshot.revision + 1,
            preferred_port_by_game: { [change.game_id]: change.port_id },
          });
        return accepted;
      },
    };
    return (
      <GroupedLibrary
        all={[first, second]}
        matching={[first, second]}
        statuses={new Map()}
        organization={organization}
        onSelect={open}
        renderPort={(port) => (
          <button
            onClick={() => {
              launch(port.id);
            }}
          >
            Play {port.name}
          </button>
        )}
      />
    );
  }
  await render(<Fixture />);
  expect(document.querySelectorAll("[data-library-game-id]")).toHaveLength(1);
  expect(document.body.textContent).not.toContain("Play First project");
  await page.getByRole("button", { name: "Use Second project", exact: true }).first().click();
  expect(document.body.textContent).not.toContain("Play Second project");
  accept(false);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your choice was not saved. Refresh choices before trying again.");
  expect(launch).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Use Second project", exact: true }).first().click();
  accept(true);
  await expect.element(page.getByRole("button", { name: "Play Second project" })).toBeVisible();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-library-game-id"))
    .toBe("game:original-game");
  await page.getByRole("button", { name: "Play Second project" }).click();
  expect(launch).toHaveBeenCalledExactlyOnceWith("second-port");
  const alternatives = document.querySelector("details")!;
  alternatives.open = true;
  await page.getByRole("button", { name: "View First project" }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith("first-port", "library:alternative:first-port");
});

it("keeps the actual filter match visible without replacing a filtered-out saved choice", async () => {
  const commit = vi.fn();
  const open = vi.fn();
  const organization: Organization = {
    snapshot: { ...empty, preferred_port_by_game: { "original-game": "first-port" } },
    busy: false,
    failure: undefined,
    refresh: async () => true,
    commit,
  };
  await render(
    <GroupedLibrary
      all={[first, second]}
      matching={[second]}
      statuses={new Map()}
      organization={organization}
      onSelect={open}
      renderPort={() => <button>Unexpected Play</button>}
    />,
  );
  expect(document.body.textContent).toContain("outside these filters");
  expect(document.body.textContent).toContain("1 matching");
  expect(document.body.textContent).not.toContain("Unexpected Play");
  expect(commit).not.toHaveBeenCalled();
  document.querySelector("details")!.open = true;
  await page.getByRole("button", { name: "View Second project" }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith("second-port", "library:alternative:second-port");
});

it("single unresolved identities need no selector or preference service and remain keyboard reachable", async () => {
  const single = { ...portDefinition(), id: "unresolved", name: "Standalone project" };
  const open = vi.fn();
  await render(
    <GroupedLibrary
      all={[single]}
      matching={[single]}
      statuses={new Map([[single.id, portStatus()]])}
      onSelect={open}
      renderPort={(port) => (
        <button
          onClick={() => {
            open(port.id);
          }}
        >
          Set up {port.name}
        </button>
      )}
    />,
  );
  expect(document.querySelector("details")).toBeNull();
  const action = page.getByRole("button", { name: "Set up Standalone project" });
  action.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(open).toHaveBeenCalledExactlyOnceWith("unresolved");
});

it("does not silently substitute a sole explicit-game survivor for a stale saved implementation", async () => {
  await render(
    <GroupedLibrary
      all={[first]}
      matching={[first]}
      statuses={new Map()}
      organization={{
        snapshot: { ...empty, preferred_port_by_game: { "original-game": "second-port" } },
        busy: false,
        failure: undefined,
        refresh: async () => true,
        commit: async () => false,
      }}
      onSelect={vi.fn()}
      renderPort={() => <button>Unexpected Play</button>}
    />,
  );
  expect(document.body.textContent).toContain("no longer in this game group");
  expect(document.body.textContent).not.toContain("Unexpected Play");
});

it("a completed choice never navigates from a dismissed comparison", async () => {
  let finish!: (accepted: boolean) => void;
  const commit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const select = vi.fn();
  await render(
    <GroupedDiscover
      all={[first, second]}
      matching={[first, second]}
      statuses={new Map()}
      onSelect={select}
      onFavoriteToggle={vi.fn()}
      organization={{
        snapshot: empty,
        busy: false,
        failure: undefined,
        refresh: async () => true,
        commit,
      }}
    />,
  );
  await page.getByRole("button", { name: "Compare ports", exact: true }).click();
  await page.getByRole("button", { name: "Use Second project", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  finish(true);
  await expect.poll(() => select.mock.calls.length).toBe(0);
  expect(commit).toHaveBeenCalledExactlyOnceWith({
    kind: "set_preferred_implementation",
    game_id: "original-game",
    port_id: "second-port",
  });
});

it("keeps the busy choice focusable and never steals focus after the player moves away", async () => {
  vi.spyOn(desktopApi, "organizationPreferences").mockResolvedValue(empty);
  let finish!: (snapshot: LibraryOrganization) => void;
  const write = vi.spyOn(desktopApi, "changeOrganization").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  function Fixture() {
    const organization = useOrganization(1);
    return (
      <>
        <button>Other action</button>
        <GroupedLibrary
          all={[first, second]}
          matching={[first, second]}
          statuses={new Map()}
          organization={organization}
          onSelect={vi.fn()}
          renderPort={(port) => <button>Play {port.name}</button>}
        />
      </>
    );
  }
  await render(<Fixture />);
  const choice = page.getByRole("button", { name: "Use Second project", exact: true }).first();
  await expect.element(choice).toBeEnabled();
  await choice.click();
  await expect.element(choice).toHaveAttribute("aria-busy", "true");
  await expect.element(choice).toHaveFocus();
  const other = page.getByRole("button", { name: "Other action", exact: true });
  await other.click();
  finish({ ...empty, revision: 1, preferred_port_by_game: { "original-game": "second-port" } });
  await expect.element(page.getByRole("button", { name: "Play Second project" })).toBeVisible();
  await expect.element(other).toHaveFocus();
  expect(write).toHaveBeenCalledExactlyOnceWith(
    0,
    { kind: "set_preferred_implementation", game_id: "original-game", port_id: "second-port" },
    1,
  );
});

it.each([
  { layout: "covers", width: 1280, theme: "dark", zoom: 1 },
  { layout: "rows", width: 1280, theme: "light", zoom: 1 },
  { layout: "covers", width: 360, theme: "dark", zoom: 1.3 },
  { layout: "rows", width: 360, theme: "light", zoom: 1.3 },
] as const)(
  "keeps grouped Library $layout/$theme/$width at $zoom readable without guessing a Play target",
  async ({ layout, width, theme, zoom }) => {
    await page.viewport(width, 900);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.zoom = String(zoom);
    const launch = vi.fn();
    const statuses = new Map(
      [first, second].map((port) => [
        port.id,
        {
          ...portStatus(),
          port_id: port.id,
          active: { ...install, id: `owned-${port.id}`, port_id: port.id },
          readiness: { launchable: true, blockers: [], pending_setup: false },
        },
      ]),
    );
    await render(
      <PortBrowser
        view="library"
        collectionLayout={layout}
        catalogUniverse={[first, second]}
        ports={[first, second]}
        statuses={statuses}
        overview={{ installed: 2, ready: 2, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        loading={false}
        onSelect={vi.fn()}
        onContinue={launch}
        organization={{
          snapshot: empty,
          busy: false,
          failure: undefined,
          commit: async () => false,
          refresh: async () => true,
        }}
      />,
    );
    await expect
      .element(page.getByRole("heading", { name: "Original game", exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll(".collection-entry")).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    const artwork = document.querySelector<HTMLElement>(".collection-art")!;
    expect(artwork.getBoundingClientRect().width).toBeGreaterThan(0);
    await expect
      .element(page.getByRole("button", { name: "Play", exact: true }))
      .not.toBeInTheDocument();
    expect(launch).not.toHaveBeenCalled();
    await page.screenshot({
      path: `../../../../outputs/a1/grouped-library-${layout}-${theme}-${width}-${zoom}.png`,
    });
  },
);
