import { useState } from "react";
import { controlledAct as act } from "../../../test/controlled-react-act";
import { OperationPresentationProvider } from "../operations/operation-presentation";
import { comparisonFixture } from "../recommendations/comparison-test-fixture";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  artworkState,
  fixtureValue,
  installedLaunchStatus,
  portDefinition,
  portStatus,
} from "../../test-fixtures";
import type {
  GameComparison,
  LibraryOrganization,
  OrganizationChange,
  PortCapabilityReport,
} from "../../types";
import { OrganizationControls, type Organization } from "../organization/OrganizationControls";
import { GroupedLibrary } from "./GroupedLibrary";
import type { CatalogEntry } from "./catalog-entry";
import { GroupedDiscover } from "./GroupedDiscover";
import { desktopApi } from "../../api";
import { ArtworkProvider } from "../../artwork";
import { useOrganization } from "../organization/use-organization";
import type { useFavorites } from "../favorites/use-favorites";
import { PortBrowser } from "../../components/PortBrowser";
import { install } from "../../dev-scenarios/interactive/scenarios";
import { browserFixture } from "../../../test/browser-fixture";
import { captureParityState } from "../../../test/parity-capture";
import { observeVisibleTarget } from "../../../scripts/browser-readiness.mts";
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

it("shows scoped launch stages beside the matching port in Discover", async () => {
  await page.viewport(960, 640);
  document.documentElement.dataset.theme = "dark";
  const artifactSha = "a".repeat(64);
  const notice: PortCapabilityReport["advisories"][number]["notice"] = {
    id: "upstream-setup-fixture",
    feature: "launch",
    platform: "windows-x86-64",
    route: "upstream-setup",
    release: "v1",
    artifact_sha256: artifactSha,
    edition: "Retail disc setup",
    explanation: "Import the disc once before using the prepared game.",
    provenance: "https://example.com/fixture",
    observed_at: 1,
    evidence: "upstream-reported",
    workaround: null,
    launch_behavior: { first_launch: "asks-for-game-files", repeat_launch: "starts-game-directly" },
  };
  const known = {
    ...first,
    listingStatus: {
      port_id: first.id,
      status: { ...portStatus(), port_id: first.id },
      actions: [],
      capabilities: {
        format_version: 1,
        port_id: first.id,
        advisory_state: "available",
        advisories: [
          { notice, applicability: "context-required" },
          {
            notice: {
              ...notice,
              id: "wrong-host",
              explanation: "Different platform",
              platform: "linux-x86-64",
            },
            applicability: "historical",
          },
        ],
        routes: [],
        observations: [],
        protection: null,
        settings: null,
        detail_problems: [],
        source_readiness: null,
        setup_guide: null,
        pending_setup: null,
      } satisfies PortCapabilityReport,
    },
  };
  const read = vi.spyOn(desktopApi, "portCapabilities");
  vi.spyOn(desktopApi, "compareGamePorts").mockResolvedValue(comparisonFixture(first.id));
  await render(
    <OperationPresentationProvider generation={1} pending={new Map()}>
      <GroupedDiscover
        all={[known, second]}
        matching={[known, second]}
        statuses={new Map()}
        devicePlatform="windows-x86-64"
        onSelect={vi.fn()}
      />
    </OperationPresentationProvider>,
  );
  await page.getByRole("button", { name: "Compare ports", exact: true }).click();
  const project = page.getByRole("article", { name: /First project/ });
  const firstLaunch = project.getByText("Asks for game files", { exact: true });
  const captureLaunchNotice = async (state: string) => {
    const noticeBlock = fixtureValue(
      firstLaunch.element().closest("dl")?.parentElement,
      "comparison launch notice",
    );
    noticeBlock.scrollIntoView({ block: "center", behavior: "instant" });
    const target = "data-launch-notice-capture";
    noticeBlock.setAttribute(target, "");
    try {
      await expect
        .poll(() => {
          const { visible, rect } = observeVisibleTarget(`[${target}]`, "visual");
          return Boolean(
            visible &&
            rect &&
            rect.y >= 0 &&
            rect.y + rect.height <= innerHeight &&
            rect.x >= 0 &&
            rect.x + rect.width <= innerWidth,
          );
        })
        .toBe(true);
      await captureParityState(`comparison-launch-notice-${state}`);
    } finally {
      noticeBlock.removeAttribute(target);
    }
  };
  await expect.element(firstLaunch).toBeVisible();
  await expect.element(project.getByText("Starts the game directly")).toBeVisible();
  await expect.element(project.getByText("Reported by the project")).toBeVisible();
  await expect.element(project.getByText("Exact context required")).toBeVisible();
  await expect.element(project.getByText(/Scope:.*release v1/)).toBeVisible();
  expect(document.body.textContent).not.toContain("Different platform");
  await captureLaunchNotice("current-platform");

  const dialog = page.getByRole("dialog", { name: "Original game", exact: true });
  await dialog.getByText("Comparison settings", { exact: true }).click();
  await page.getByRole("combobox", { name: /Game edition/ }).click();
  await page.getByRole("option", { name: "Fixture original", exact: true }).click();
  await expect
    .poll(() => vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].edition_id)
    .toBe("fixture-edition");
  await expect.element(project.getByText(notice.explanation)).toBeVisible();
  await expect.element(project.getByText(/Scope:.*Retail disc setup/)).toBeVisible();
  await page.getByRole("combobox", { name: /Target platform/ }).click();
  await page.getByRole("option", { name: "Linux", exact: true }).click();
  await expect.element(project.getByText("Different platform")).toBeVisible();
  await expect.element(project.getByText("Exact context required")).toBeVisible();
  await expect.element(project.getByText(/Scope: linux-x86-64/)).toBeVisible();
  expect(document.body.textContent).not.toContain(notice.explanation);
  expect(read).not.toHaveBeenCalled();
  await page.viewport(430, 780);
  document.documentElement.dataset.theme = "light";
  await captureLaunchNotice("explicit-platform");
  const artifact = project.getByText(artifactSha, { exact: true });
  const details = project.getByText("View technical details", { exact: true });
  await expect.element(artifact).not.toBeVisible();
  details.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(artifact).toBeVisible();
  await expect.element(details).toHaveFocus();
  const summary = details.element();
  const hashBody = fixtureValue(artifact.element().closest("p"), "expanded checksum");
  const outline = getComputedStyle(summary);
  expect(outline.outlineStyle).not.toBe("none");
  const outlineBottom =
    summary.getBoundingClientRect().bottom +
    Number.parseFloat(outline.outlineWidth) +
    Number.parseFloat(outline.outlineOffset);
  expect(hashBody.getBoundingClientRect().top).toBeGreaterThanOrEqual(outlineBottom);
  await captureLaunchNotice("artifact-details");
  await userEvent.keyboard("{Enter}");
  await expect.element(artifact).not.toBeVisible();
  await expect.element(details).toHaveFocus();
});

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
  expect(document.body.textContent).toContain(
    "Check its setup instructions for shared save locations before switching.",
  );
  expect(document.body.textContent).not.toContain("Play First project");
  await page.getByRole("button", { name: "Choose Second project", exact: true }).first().click();
  expect(write).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("Play Second project");
  accept(false);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Portcove couldn’t confirm that your choice was saved. Refresh choices to check.",
    );
  expect(launch).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Refresh choices" }).click();
  await page.getByRole("button", { name: "Choose Second project", exact: true }).first().click();
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
  await page.getByRole("button", { name: "Choose Second project", exact: true }).click();
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

it("reads back a committed port choice after its acknowledgement is lost", async () => {
  let stored = empty;
  const read = vi
    .spyOn(desktopApi, "organizationPreferences")
    .mockImplementation(async () => stored);
  const write = vi.spyOn(desktopApi, "changeOrganization").mockImplementation(async () => {
    stored = { ...empty, revision: 1, preferred_port_by_game: { "original-game": "second-port" } };
    throw new Error("Response lost after saving");
  });
  function Fixture() {
    const organization = useOrganization(1);
    return (
      <GroupedLibrary
        all={[first, second]}
        matching={[first, second]}
        statuses={new Map()}
        organization={organization}
        onSelect={vi.fn()}
        renderPort={(port) => <button>Play {port.name}</button>}
      />
    );
  }
  await render(<Fixture />);
  await page
    .getByRole("button", { name: /^(Choose|Use) Second project$/ })
    .first()
    .click();
  await expect.element(page.getByRole("alert")).toMatchTextContent(/couldn’t confirm/);
  await expect
    .element(page.getByRole("button", { name: "Play Second project" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Refresh choices" }).click();
  await expect.element(page.getByRole("button", { name: "Play Second project" })).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(1);
});

it("re-enables an unsaved choice after a shared reload confirms the same revision", async () => {
  vi.spyOn(desktopApi, "organizationPreferences")
    .mockResolvedValueOnce(empty)
    .mockRejectedValueOnce(new Error("Choices could not be read"))
    .mockResolvedValue({ ...empty });
  const write = vi
    .spyOn(desktopApi, "changeOrganization")
    .mockRejectedValue(new Error("Choice was not stored"));
  function Fixture() {
    const organization = useOrganization(1);
    return (
      <>
        <OrganizationControls
          organization={organization}
          selected="all"
          onSelect={vi.fn()}
          discover={false}
        />
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
  const choice = page.getByRole("button", { name: /^(Choose|Use) Second project$/ }).first();
  await choice.click();
  await expect.element(choice).toBeDisabled();
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  const collections = page.getByRole("group", { name: "Library collections" });
  const reload = collections.getByRole("button", { name: "Reload choices", exact: true });
  await reload.click();
  await expect
    .element(collections.getByRole("alert"))
    .toMatchTextContent(
      /^Saved choices could not be refreshed\. Showing your last confirmed choices\./,
    );
  await expect.element(choice).toBeDisabled();
  await reload.click();
  await expect.element(collections.getByRole("alert")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(choice).toBeEnabled();
  await expect.element(page.getByText(/couldn’t confirm that your choice/)).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Play Second project" }))
    .not.toBeInTheDocument();
  expect(write).toHaveBeenCalledTimes(1);
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
  const choice = page.getByRole("button", { name: "Choose Second project", exact: true }).first();
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
        libraryCount={2}
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
      path: `../../../../../outputs/ui-refinement/grouped-library-${layout}-${theme}-${width}-${zoom}.png`,
    });
    const summary = page.elementLocator(
      fixtureValue(
        document.querySelector<HTMLElement>('summary[data-collection-control="alternatives"]'),
        "Library alternatives",
      ),
    );
    const disclosure = summary.element().closest("details")!;
    const row = disclosure.closest("[data-collection-row]")!;
    const fits = () =>
      disclosure.getBoundingClientRect().bottom <= row.getBoundingClientRect().bottom + 1;
    expect(disclosure.open).toBe(false);
    await expect.poll(fits).toBe(true);
    await summary.click();
    await expect.poll(() => disclosure.open).toBe(true);
    await expect.poll(fits).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    await summary.click();
    await expect.poll(() => disclosure.open).toBe(false);
  },
);

it("presents grouped Discover cards and the comparison in the active locale", async () => {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await render(
      <GroupedDiscover
        all={[first, second]}
        matching={[first, second]}
        statuses={new Map()}
        onSelect={vi.fn()}
      />,
    );
    expect(document.querySelector("article")?.getAttribute("aria-label")).toBe(
      "Original game. 2 options; 2 matching.",
    );
    await localization.changeLanguage("ar-XB");
    await expect
      .poll(() => document.querySelector("article")?.getAttribute("aria-label"))
      .toBe("Original game. خياران؛ 2 مطابقة.");
    expect(document.querySelector("section")?.getAttribute("aria-label")).toBe("اكتشاف الألعاب");
    expect(document.body.textContent).toContain(
      "قارن المنافذ المطابقة لمعرفة متطلبات الإعداد وحالة التثبيت الخاصة بكل منها.",
    );
    await page.getByRole("button", { name: "مقارنة المنافذ", exact: true }).click();
    await expect
      .poll(() => document.querySelector("[role=dialog]")?.textContent)
      .toContain("قارن متطلبات الإعداد للخيارات (2).");
    const dialog = document.querySelector("[role=dialog]")?.textContent;
    expect(dialog).toContain("من يتولى التحديثات");
    expect(dialog).toContain("الجهة المسؤولة عن التثبيت غير معروفة.");
  } finally {
    await localization.changeLanguage("en");
  }
});

it("names a chosen port in a multi-port group with its matching project and action", async () => {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await render(
      <GroupedDiscover
        all={[first, second]}
        matching={[first]}
        statuses={new Map()}
        onSelect={vi.fn()}
      />,
    );
    const identity = () =>
      document.querySelector(".discover-game-identity")?.getAttribute("aria-label") ?? "";
    expect(identity()).toMatch(
      /^Original game 2 options\. Matching port: First project\. .+\. View port$/u,
    );
    expect(document.body.textContent).toContain("Matching port: First project");
    expect(document.body.textContent).toContain("Compare all 2");
    await localization.changeLanguage("ar-XB");
    await expect
      .poll(identity)
      .toMatch(/^Original game خياران\. المنفذ المطابق: First project\. .+\. عرض المنفذ$/u);
    expect(document.querySelector(".discover-game-observation bdi")?.textContent).toBe(
      "First project",
    );
  } finally {
    await localization.changeLanguage("en");
  }
});

it("on a known device, replaces Discover platform chips with an exception for excluded ports", async () => {
  const windowsOnly = { ...portDefinition(), id: "windows-only", name: "Windows only" };
  const linuxOnly = {
    ...portDefinition(),
    id: "linux-only",
    name: "Linux only",
    platforms: ["linux-x86-64" as const],
  };
  const unlisted = { ...portDefinition(), id: "unlisted", name: "Unlisted", platforms: [] };
  const ports = [windowsOnly, linuxOnly, unlisted];
  const card = (id: string) =>
    [...document.querySelectorAll<HTMLElement>(".discover-game")].find((item) =>
      (JSON.parse(item.dataset.discoverPortIds!) as string[]).includes(id),
    )!;
  const platformChips = (id: string) =>
    [...card(id).querySelectorAll('[title="Runs on"]')].map((chip) => chip.textContent?.trim());
  const screen = await render(
    <GroupedDiscover
      all={ports}
      matching={ports}
      statuses={new Map()}
      onSelect={vi.fn()}
      devicePlatform="windows-x86-64"
    />,
  );
  for (const id of ["windows-only", "linux-only", "unlisted"])
    expect(platformChips(id)).toEqual([]);
  // Only a port whose listed platforms exclude this device names the exception.
  expect(card("linux-only").textContent).toContain("Not available for Windows");
  expect(card("windows-only").textContent).not.toContain("Not available for");
  // An unlisted platform is unknown, not a known exclusion.
  expect(card("unlisted").textContent).not.toContain("Not available for");

  await screen.rerender(
    <GroupedDiscover all={ports} matching={ports} statuses={new Map()} onSelect={vi.fn()} />,
  );
  // Without a known device, every card keeps listing its platforms.
  expect(platformChips("windows-only")).toEqual(["Windows"]);
  expect(platformChips("linux-only")).toEqual(["Linux"]);
  expect(document.body.textContent).not.toContain("Not available for");
});

it("names the device exception in the active locale", async () => {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  const linuxOnly = {
    ...portDefinition(),
    id: "linux-only",
    name: "Linux only",
    platforms: ["linux-x86-64" as const],
  };
  try {
    await render(
      <GroupedDiscover
        all={[linuxOnly]}
        matching={[linuxOnly]}
        statuses={new Map()}
        onSelect={vi.fn()}
        devicePlatform="macos-aarch64"
      />,
    );
    expect(document.body.textContent).toContain("Not available for Apple silicon");
    await localization.changeLanguage("es");
    await expect
      .poll(() => document.body.textContent)
      .toContain("No disponible para Apple silicon");
  } finally {
    await localization.changeLanguage("en");
  }
});

it("omits empty rows from a single-port review while a comparison keeps every row aligned", async () => {
  const bare = {
    ...first,
    platforms: [],
    channels: [],
    presentation: { ...first.presentation, source_requirements: [] },
  };
  const rows = () => [...document.querySelectorAll("[role=dialog] h4")].map((h) => h.textContent);
  const dialogText = () => document.querySelector("[role=dialog]")?.textContent ?? "";

  const single = await render(
    <GroupedDiscover
      all={[bare]}
      matching={[bare]}
      statuses={new Map([[bare.id, { ...portStatus(), port_id: bare.id }]])}
      onSelect={vi.fn()}
    />,
  );
  await page.getByRole("button", { name: "Why this port?", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  // No setup method, no listed files and no installation: nothing to show for those rows.
  expect(rows()).not.toContain("How to set it up");
  expect(rows()).not.toContain("Required files");
  expect(rows()).not.toContain("Who handles updates");
  expect(dialogText()).not.toContain("No platform is listed.");
  expect(dialogText()).not.toContain("No update channel is listed.");
  expect(dialogText()).not.toContain("Unavailable in this catalog");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  // A single port with values keeps those rows.
  const described = {
    ...first,
    presentation: {
      ...first.presentation,
      installation_method: "portable-package" as const,
      source_requirements: [
        {
          role: "game" as const,
          profile_id: "fixture-copy",
          label: "Your fixture copy",
          verification: "catalog-identity" as const,
        },
      ],
    },
  };
  await single.rerender(
    <GroupedDiscover
      all={[described]}
      matching={[described]}
      statuses={new Map([[described.id, installedLaunchStatus()]])}
      onSelect={vi.fn()}
    />,
  );
  await page.getByRole("button", { name: "Why this port?", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(rows()).toEqual(
    expect.arrayContaining(["How to set it up", "Required files", "Who handles updates"]),
  );
  expect(dialogText()).toContain("Download and install");
  expect(dialogText()).toContain("Your fixture copy");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  // An optional game source is not listed under a heading that says "Required".
  const optional = { ...described, optional_game_source: true };
  await single.rerender(
    <GroupedDiscover
      all={[optional]}
      matching={[optional]}
      statuses={new Map([[optional.id, installedLaunchStatus()]])}
      onSelect={vi.fn()}
    />,
  );
  await page.getByRole("button", { name: "Why this port?", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(rows()).toContain("Optional files");
  expect(rows()).not.toContain("Required files");
  expect(dialogText()).toContain("Your fixture copy");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  // Two ports keep every row, including the absences, so they line up for comparison.
  const other = { ...bare, id: "other-port", name: "Other project" };
  await single.rerender(
    <GroupedDiscover
      all={[bare, other]}
      matching={[bare, other]}
      statuses={new Map()}
      onSelect={vi.fn()}
    />,
  );
  await page.getByRole("button", { name: "Compare ports", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const headings = rows();
  for (const row of ["How to set it up", "Required files", "Who handles updates"])
    expect(headings.filter((heading) => heading === row)).toHaveLength(2);
  expect(dialogText().split("No platform is listed.")).toHaveLength(3);
  expect(dialogText().split("No update channel is listed.")).toHaveLength(3);
  expect(dialogText()).toContain("Unavailable in this catalog");
  expect(dialogText()).toContain("Requirements are not listed here.");
});

it("keeps stable game presentation while selected actions and file drops use the exact implementation", async () => {
  const sourceFirst = { ...first, source_profile: "first-source" };
  const selected = {
    ...second,
    source_profile: "second-source",
    presentation: { ...second.presentation, original_game_title: "Regional alias" },
  };
  const organization: Organization = {
    snapshot: { ...empty, preferred_port_by_game: { "original-game": selected.id } },
    busy: false,
    failure: undefined,
    refresh: async () => true,
    commit: vi.fn(),
  };
  const onSelect = vi.fn();
  const screen = await render(
    <GroupedDiscover
      all={[selected, sourceFirst]}
      matching={[selected]}
      statuses={new Map()}
      organization={organization}
      nativeSourceDrag={{ active: true, pathCount: 1 }}
      onSelect={onSelect}
    />,
  );
  const card = () => document.querySelector<HTMLElement>(".discover-game")!;
  expect(card().querySelector("h2")?.textContent).toBe("Original game");
  expect(card().dataset.discoverPrimaryPortId).toBe(selected.id);
  expect(card().dataset.sourceDropPortId).toBe(selected.id);
  expect(card().dataset.sourceDropProfileId).toBe(selected.source_profile);
  await page.getByRole("button", { name: /Matching port: Second project/u }).click();
  expect(onSelect).toHaveBeenCalledWith(selected.id, `catalog:card:${selected.id}`);
  await screen.rerender(
    <GroupedDiscover
      all={[sourceFirst, selected]}
      matching={[sourceFirst, selected]}
      statuses={new Map()}
      organization={organization}
      onSelect={onSelect}
    />,
  );
  expect(card().querySelector("h2")?.textContent).toBe("Original game");
  expect(organization.commit).not.toHaveBeenCalled();
});

it.each(["filter", "device"] as const)(
  "keeps a %s click shortcut separate from cancelled and confirmed ambiguous file drops",
  async (shortcut) => {
    const first = {
      ...portDefinition(),
      id: "first-port",
      name: "First project",
      presentation: second.presentation,
      source_profile: "first-source",
    };
    const secondPort = {
      ...second,
      source_profile: "second-source",
      platforms: ["linux-x86-64" as const],
    };
    const onSelect = vi.fn();
    const onGameDropSelect = vi.fn();
    const onGameDropDismiss = vi.fn();
    const commit = vi.fn();
    const organization: Organization = {
      snapshot: empty,
      busy: false,
      failure: undefined,
      refresh: async () => true,
      commit,
    };
    const view = (pendingGameDrop?: { gameId: string; paths: string[] }) => (
      <GroupedDiscover
        all={[first, secondPort]}
        matching={shortcut === "filter" ? [secondPort] : [first, secondPort]}
        devicePlatform={shortcut === "device" ? "windows-x86-64" : undefined}
        statuses={new Map()}
        organization={organization}
        nativeSourceDrag={{ active: true, pathCount: 1 }}
        pendingGameDrop={pendingGameDrop}
        onGameDropSelect={onGameDropSelect}
        onGameDropDismiss={onGameDropDismiss}
        onSelect={onSelect}
      />
    );
    const screen = await render(view());
    expect(
      document.querySelector<HTMLElement>(".discover-game")?.dataset.sourceDropPortId,
    ).toBeUndefined();
    expect(document.querySelector<HTMLElement>(".discover-game")?.dataset.sourceDropGameId).toBe(
      "game:original-game",
    );
    const clicked = shortcut === "device" ? first : secondPort;
    await page
      .getByRole("button", { name: new RegExp(`Matching port: ${clicked.name}`, "u") })
      .click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(clicked.id, `catalog:card:${clicked.id}`);
    expect(onGameDropSelect).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    onGameDropDismiss.mockClear();

    await screen.rerender(view({ gameId: "game:original-game", paths: ["D:/Game.z64"] }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(onGameDropSelect).not.toHaveBeenCalled();
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    expect(onGameDropDismiss).toHaveBeenCalledExactlyOnceWith();
    await screen.rerender(view());
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(onGameDropSelect).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    await screen.rerender(view({ gameId: "game:original-game", paths: ["D:/Game.z64"] }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("button", { name: "Check files with Second project", exact: true })
      .click();
    expect(onGameDropSelect).toHaveBeenCalledExactlyOnceWith({
      portId: second.id,
      profileId: secondPort.source_profile,
      paths: ["D:/Game.z64"],
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  },
);

it("supplies a stable game presentation separately from the Library action target", async () => {
  const selected = {
    ...second,
    presentation: { ...second.presentation, original_game_title: "Regional alias" },
  };
  const renderPort = vi.fn((port: CatalogEntry, presentationPort?: CatalogEntry) => (
    <button>
      Play {port.id}: {presentationPort?.presentation?.original_game_title}
    </button>
  ));
  const organization: Organization = {
    snapshot: { ...empty, preferred_port_by_game: { "original-game": selected.id } },
    busy: false,
    failure: undefined,
    refresh: async () => true,
    commit: vi.fn(),
  };
  await render(
    <GroupedLibrary
      all={[selected, first]}
      matching={[selected]}
      statuses={new Map()}
      organization={organization}
      onSelect={vi.fn()}
      renderPort={renderPort}
    />,
  );
  expect(renderPort).toHaveBeenCalledWith(selected, first, expect.any(Object));
  await expect
    .element(page.getByRole("button", { name: "Play second-port: Original game" }))
    .toBeVisible();
});

it("continues a choice while optional comparison evidence remains pending", async () => {
  const onSelect = vi.fn();
  const onGameDropDismiss = vi.fn();
  let finishComparison!: (report: GameComparison) => void;
  const comparison = vi.spyOn(desktopApi, "compareGamePorts").mockImplementation(
    () =>
      new Promise<GameComparison>((resolve) => {
        finishComparison = resolve;
      }),
  );
  const organization: Organization = {
    snapshot: empty,
    busy: false,
    failure: undefined,
    refresh: async () => true,
    commit: vi.fn(async () => true),
  };
  function Fixture() {
    const [pendingGameDrop, setDrop] = useState<{ gameId: string; paths: string[] } | undefined>({
      gameId: "game:original-game",
      paths: ["D:/Game.z64"],
    });
    return (
      <OperationPresentationProvider generation={1} pending={new Map()}>
        <GroupedDiscover
          all={[first, second]}
          matching={[first, second]}
          statuses={new Map()}
          organization={organization}
          pendingGameDrop={pendingGameDrop}
          onGameDropDismiss={() => {
            onGameDropDismiss();
            setDrop(undefined);
          }}
          onSelect={onSelect}
        />
      </OperationPresentationProvider>
    );
  }
  await render(<Fixture />);
  await expect.poll(() => comparison.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "Choose Second project", exact: true }).click();
  await expect.poll(() => onSelect.mock.calls.length).toBe(1);
  expect(onSelect).toHaveBeenCalledWith(second.id, `catalog:card:${first.id}`);
  expect(onGameDropDismiss).toHaveBeenCalledOnce();
  await act(async () => finishComparison(comparisonFixture(first.id)));
  expect(onSelect).toHaveBeenCalledOnce();
});

it.each(["close", "library generation"] as const)(
  "does not navigate on a late choice acknowledgement after dropped-file review changes by %s",
  async (change) => {
    const onSelect = vi.fn();
    const onGameDropDismiss = vi.fn();
    let finishChoice!: (accepted: boolean) => void;
    const replies: ((report: GameComparison) => void)[] = [];
    vi.spyOn(desktopApi, "compareGamePorts").mockImplementation(
      () => new Promise<GameComparison>((resolve) => replies.push(resolve)),
    );
    const organization: Organization = {
      snapshot: empty,
      busy: false,
      failure: undefined,
      refresh: async () => true,
      commit: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishChoice = resolve;
          }),
      ),
    };
    function Fixture({ generation = 1 }: { generation?: number }) {
      const [pendingGameDrop, setDrop] = useState<{ gameId: string; paths: string[] } | undefined>({
        gameId: "game:original-game",
        paths: ["D:/Game.z64"],
      });
      return (
        <OperationPresentationProvider generation={generation} pending={new Map()}>
          <GroupedDiscover
            all={[first, second]}
            matching={[first, second]}
            statuses={new Map()}
            organization={organization}
            pendingGameDrop={pendingGameDrop}
            onGameDropDismiss={() => {
              onGameDropDismiss();
              setDrop(undefined);
            }}
            onSelect={onSelect}
          />
        </OperationPresentationProvider>
      );
    }
    const screen = await render(<Fixture />);
    await page.getByRole("button", { name: "Choose Second project", exact: true }).click();
    if (change === "close") await userEvent.keyboard("{Escape}");
    else await screen.rerender(<Fixture generation={2} />);
    await expect.poll(() => Boolean(document.querySelector('[role="dialog"]'))).toBe(false);
    expect(onGameDropDismiss).toHaveBeenCalledOnce();
    await act(async () => {
      finishChoice(true);
      replies.forEach((reply) => reply(comparisonFixture(first.id)));
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onGameDropDismiss).toHaveBeenCalledOnce();
    expect(organization.commit).toHaveBeenCalledExactlyOnceWith({
      kind: "set_preferred_implementation",
      game_id: "original-game",
      port_id: second.id,
    });
  },
);

it("retains ambiguous dropped originals through an acknowledged eligible implementation choice", async () => {
  const onSelect = vi.fn();
  const onGameDropSelect = vi.fn();
  const chosen = { ...second, source_profile: "chosen-source" };
  const organization: Organization = {
    snapshot: empty,
    busy: false,
    failure: undefined,
    refresh: async () => true,
    commit: vi.fn(async () => true),
  };
  vi.spyOn(desktopApi, "compareGamePorts").mockImplementation(
    () => new Promise<GameComparison>(() => {}),
  );
  await render(
    <OperationPresentationProvider generation={1} pending={new Map()}>
      <GroupedDiscover
        all={[first, chosen]}
        matching={[first, chosen]}
        statuses={new Map()}
        organization={organization}
        pendingGameDrop={{ gameId: "game:original-game", paths: ["D:/Original.z64"] }}
        onGameDropSelect={onGameDropSelect}
        onSelect={onSelect}
      />
    </OperationPresentationProvider>,
  );
  await page.getByRole("button", { name: "Choose Second project", exact: true }).click();
  await expect.poll(() => onGameDropSelect.mock.calls.length).toBe(1);
  expect(onGameDropSelect).toHaveBeenCalledExactlyOnceWith({
    portId: chosen.id,
    profileId: "chosen-source",
    paths: ["D:/Original.z64"],
  });
  expect(onSelect).not.toHaveBeenCalled();
});

it.each([
  { mode: "both", width: 960, theme: "dark", reports: "all", single: false },
  { mode: "mixed", width: 430, theme: "light", reports: "first", single: false },
  { mode: "mixed", width: 960, theme: "dark", reports: "first", single: false },
  { mode: "omitted", width: 960, theme: "dark", reports: "none", single: false },
  { mode: "bare", width: 430, theme: "light", reports: "none", single: true },
  { mode: "described", width: 960, theme: "dark", reports: "all", single: true },
] as const)(
  "keeps $mode comparison information above status and actions at $width px in $theme",
  async ({ mode, width, theme, reports, single }) => {
    await page.viewport(width, width < 600 ? 780 : 800);
    document.documentElement.dataset.theme = theme;
    const implementation = {
      format_version: 1,
      methods: [
        {
          kind: "engine-reimplementation" as const,
          note: "SYNTHETIC presentation fixture with complete project evidence. ".repeat(5),
          evidence_urls: ["https://example.com/fixture-method"],
        },
      ],
      dependencies: [],
    };
    const ports = (single ? [first] : [first, second]).map((port, index) => {
      const hasMetadata =
        mode === "both" || ((mode === "mixed" || mode === "described") && index === 0);
      return {
        ...port,
        name: width < 600 ? `${port.name} with a long wrapped project identity` : port.name,
        ...(mode === "bare" ? { platforms: [], channels: [] } : {}),
        presentation: {
          ...port.presentation,
          ...(mode === "bare"
            ? { source_requirements: [] }
            : {
                installation_method: "portable-package" as const,
                source_requirements: [
                  {
                    role: "game" as const,
                    profile_id: "fixture-copy",
                    label: "Your fixture copy",
                    verification: "catalog-identity" as const,
                  },
                ],
              }),
          ...(hasMetadata
            ? { implementation }
            : index === 1
              ? { implementation: { format_version: 999, methods: [], dependencies: [] } }
              : {}),
        },
      };
    });
    const reportPorts = reports === "none" ? [] : reports === "first" ? ports.slice(0, 1) : ports;
    const compare = vi.spyOn(desktopApi, "compareGamePorts").mockResolvedValue(
      comparisonFixture(ports[0]!.id, {
        game_id: "original-game",
        assessment: null,
        ports: reportPorts.map((port) => ({
          ...fixtureValue(comparisonFixture(port.id).ports[0], "comparison report port"),
          name: port.name,
          offered_release: null,
        })),
      }),
    );
    const commit = vi.fn(async () => true);
    const organization: Organization = {
      snapshot: empty,
      busy: false,
      failure: undefined,
      commit,
      refresh: async () => true,
    };
    const statuses = new Map(
      ports.map((port) => [
        port.id,
        mode === "bare"
          ? { ...portStatus(), port_id: port.id }
          : {
              ...installedLaunchStatus(),
              port_id: port.id,
              active: { ...install, id: `fixture-${port.id}`, port_id: port.id },
            },
      ]),
    );
    const select = vi.fn();
    await render(
      <OperationPresentationProvider generation={1} pending={new Map()}>
        <GroupedDiscover
          all={ports}
          matching={ports}
          statuses={statuses}
          organization={organization}
          onSelect={select}
        />
      </OperationPresentationProvider>,
    );
    await page
      .getByRole("button", { name: single ? "Why this port?" : "Compare ports", exact: true })
      .click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => compare.mock.calls.length).toBeGreaterThan(0);
    await expect
      .poll(() => document.querySelectorAll('[aria-label^="Reports and updates for "]').length)
      .toBe(reportPorts.length);
    await document.fonts.ready;
    const cards = [...document.querySelectorAll<HTMLElement>(".port-comparison-project")];
    expect(cards).toHaveLength(ports.length);
    const geometry = () =>
      cards.map((card) => {
        const heading = [...card.querySelectorAll("h4")].find(
          (item) => item.textContent === "Current status",
        );
        const status = fixtureValue(heading?.parentElement, "comparison current status");
        const footer = fixtureValue(card.lastElementChild, "comparison footer");
        const actions = [...footer.querySelectorAll<HTMLElement>("button, a")];
        expect(actions.length).toBeGreaterThan(0);
        const text = document.createRange();
        text.selectNodeContents(status);
        const statusBounds = text.getBoundingClientRect();
        const firstActionTop = Math.min(
          ...actions.map((action) => action.getBoundingClientRect().top),
        );
        expect(statusBounds.bottom).toBeLessThanOrEqual(firstActionTop);
        const cardBounds = card.getBoundingClientRect();
        for (const action of actions) {
          const bounds = action.getBoundingClientRect();
          expect(bounds.width).toBeGreaterThan(0);
          expect(bounds.height).toBeGreaterThan(0);
          expect(bounds.left).toBeGreaterThanOrEqual(cardBounds.left);
          expect(bounds.right).toBeLessThanOrEqual(cardBounds.right);
          expect(bounds.bottom).toBeLessThanOrEqual(cardBounds.bottom);
        }
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
        const projectDetails = [...card.querySelectorAll("details")].filter((details) =>
          details
            .querySelector(":scope > summary")
            ?.textContent?.startsWith("How this project works"),
        );
        for (const details of projectDetails) {
          // An expanded peer must not stretch a closed disclosure into a blank grid track.
          const children = details.open
            ? [...details.children]
            : [fixtureValue(details.querySelector(":scope > summary"), "project summary")];
          const visible = children
            .map((child) => child.getBoundingClientRect())
            .filter((bounds) => bounds.width > 0 && bounds.height > 0);
          expect(visible.length).toBeGreaterThan(0);
          const contentHeight =
            Math.max(...visible.map((bounds) => bounds.bottom)) -
            Math.min(...visible.map((bounds) => bounds.top));
          expect(
            Math.abs(details.getBoundingClientRect().height - contentHeight),
          ).toBeLessThanOrEqual(1);
        }
        return { status, footer, statusTop: statusBounds.top, actionTop: firstActionTop };
      });
    const capture = async (state: string) => {
      const rows = geometry();
      const aligned = (position: "statusTop" | "actionTop") =>
        rows.every((row) => Math.abs(row[position] - rows[0]![position]) <= 1);
      const sharedRow = width === 960 || rows.length === 1;
      expect(aligned("statusTop")).toBe(sharedRow);
      expect(aligned("actionTop")).toBe(sharedRow);
      for (const [index, row] of (width < 600 ? rows : rows.slice(0, 1)).entries()) {
        row.footer.scrollIntoView({ block: "center", behavior: "instant" });
        const bounds = row.footer.getBoundingClientRect();
        expect(row.status.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
        await captureParityState(`comparison-${mode}-${state}-status-actions-${index}`);
      }
    };
    await capture("collapsed");
    const summaries = cards.flatMap((card) =>
      [...card.querySelectorAll<HTMLElement>("summary")].filter((summary) =>
        summary.textContent?.startsWith("How this project works"),
      ),
    );
    expect(summaries).toHaveLength(
      mode === "both" ? 2 : mode === "mixed" || mode === "described" ? 1 : 0,
    );
    for (const summary of summaries.slice(0, 1)) {
      summary.focus();
      await userEvent.keyboard("{Enter}");
      expect(summary.closest("details")!.open).toBe(true);
      expect(document.activeElement).toBe(summary);
      await capture("expanded");
      // Capture scrolling must not transfer keyboard ownership away from the disclosure.
      expect(document.activeElement).toBe(summary);
      await userEvent.keyboard("{Enter}");
      expect(summary.closest("details")!.open).toBe(false);
      geometry();
    }
    expect(cards[0]!.textContent?.includes("How to set it up")).toBe(mode !== "bare");
    expect(select).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  },
);

it("shows the installed port's Cover on a grouped Library card", async () => {
  const sibling = {
    ...first,
    presentation: {
      ...first.presentation,
      installation_method: "portable-package" as const,
      saves_and_settings: "portcove-managed" as const,
      source_requirements: [],
    },
  };
  const selected = {
    ...second,
    presentation: { ...sibling.presentation, original_game_title: "Regional alias" },
  };
  const catalog = { schema_version: 2, ports: [sibling, selected] };
  const generation = 7;
  const revision = 3;
  const image = document.createElement("canvas");
  image.width = 2;
  image.height = 3;
  const paint = fixtureValue(image.getContext("2d"), "fixture Cover canvas");
  paint.fillStyle = "#176799";
  paint.fillRect(0, 0, image.width, image.height);
  const bytes = fixtureValue(image.toDataURL("image/png").split(",")[1], "fixture Cover");
  const readArtwork = vi
    .spyOn(desktopApi, "artwork")
    .mockImplementation(async (id, slot) =>
      artworkState(
        id,
        slot,
        id === selected.id ? revision : 0,
        id === selected.id && slot === "cover",
      ),
    );
  const readThumbnail = vi
    .spyOn(desktopApi, "artworkThumbnail")
    .mockImplementation(async (_id, _slot, choiceRevision) => ({
      asset_sha256: "a".repeat(64),
      choice_revision: choiceRevision,
      png_base64: bytes,
    }));
  const status = installedLaunchStatus();
  await render(
    <ArtworkProvider generation={generation} catalog={catalog}>
      <PortBrowser
        view="library"
        collectionLayout="covers"
        catalogUniverse={catalog.ports}
        ports={[selected]}
        statuses={
          new Map([
            [
              selected.id,
              { ...status, port_id: selected.id, active: { ...install, port_id: selected.id } },
            ],
          ])
        }
        libraryCount={1}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        loading={false}
        onSelect={vi.fn()}
      />
    </ArtworkProvider>,
  );

  const card = page.getByRole("button", { name: "View details for Original game Second project" });
  await expect.element(card).toBeVisible();
  const selector = '[data-artwork-source="local_import"] img';
  await expect
    .poll(() => card.element().querySelector<HTMLImageElement>(selector)?.naturalHeight)
    .toBe(3);
  const displayed = card.element().querySelector<HTMLImageElement>(selector);
  expect(displayed?.closest("[data-artwork-port-id]")?.getAttribute("data-artwork-port-id")).toBe(
    selected.id,
  );
  expect(readArtwork.mock.calls.some(([id, role]) => id === first.id && role === "cover")).toBe(
    false,
  );
  expect(
    readThumbnail.mock.calls.some(
      ([id, role, choiceRevision, currentGeneration]) =>
        id === selected.id &&
        role === "cover" &&
        choiceRevision === revision &&
        currentGeneration === generation,
    ),
  ).toBe(true);
});

async function renderFilteredUnifiedFavorite(view: "catalog" | "library") {
  const selected = {
    ...second,
    presentation: { ...second.presentation, original_game_title: "Regional alias" },
  };
  const commit = vi.fn(async (_change: OrganizationChange) => true);
  const organization: Organization = {
    snapshot: {
      ...empty,
      saved_game_ids: [`port-${first.id}`, "port-retired-port"],
      preferred_port_by_game: { "original-game": selected.id },
    },
    busy: false,
    failure: undefined,
    refresh: async () => true,
    commit,
  };
  const setPorts = vi.fn(
    async (_ids: readonly string[], _favorite: boolean, before?: () => Promise<boolean>) =>
      before ? before() : true,
  );
  const favorites: ReturnType<typeof useFavorites> = {
    ids: new Set([first.id, "retired-port"]),
    only: false,
    setOnly: vi.fn(),
    busy: false,
    failure: undefined,
    refresh: async () => true,
    toggle: async () => true,
    setPorts,
  };
  const onSelect = vi.fn();
  await render(
    <PortBrowser
      view={view}
      ports={[selected]}
      catalogUniverse={[selected, first]}
      catalogFilterCandidates={[selected, first]}
      libraryCount={1}
      statuses={new Map()}
      overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
      filter="all"
      setFilter={vi.fn()}
      loading={false}
      organization={organization}
      favorites={favorites}
      onSelect={onSelect}
    />,
  );
  return { selected, commit, setPorts, favorites, organization, onSelect };
}

it.each(["catalog", "library"] as const)(
  "removes a unified Favorite across filtered-out siblings in %s without selecting their actions",
  async (view) => {
    const { selected, commit, setPorts, favorites, organization, onSelect } =
      await renderFilteredUnifiedFavorite(view);
    const favorite = page.getByRole("button", { name: "Favorite Original game", exact: true });
    await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
    await favorite.click();
    await expect.poll(() => commit.mock.calls.length).toBe(1);
    expect(setPorts).toHaveBeenCalledWith([first.id], false, expect.any(Function));
    const change = commit.mock.calls[0]?.[0];
    expect(change?.kind).toBe("set_saved_group");
    if (change?.kind !== "set_saved_group") throw new Error("Expected exact game Favorite request");
    expect(change.game_id).toBe("game-original-game");
    expect(change.saved).toBe(false);
    expect(change.legacy_port_ids).toHaveLength(2);
    expect(change.legacy_port_ids).toEqual(expect.arrayContaining([first.id, selected.id]));
    expect(onSelect).not.toHaveBeenCalled();
    expect(favorites.ids).toEqual(new Set([first.id, "retired-port"]));
    expect(organization.snapshot?.saved_game_ids).toContain("port-retired-port");
  },
);

it("names Library details with the visible stable game and exact project while opening the selected port", async () => {
  const { selected, onSelect } = await renderFilteredUnifiedFavorite("library");
  const details = page.getByRole("button", {
    name: "View details for Original game Second project",
    exact: true,
  });
  await expect.element(details).toHaveTextContent("Original game Second project");
  await details.click();
  expect(onSelect).toHaveBeenCalledWith(selected.id, `library:card:${selected.id}`);
});
