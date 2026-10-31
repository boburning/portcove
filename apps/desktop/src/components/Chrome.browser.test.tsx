import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import { portDefinition, sourceProfile } from "../test-fixtures";
import { PageHeader, SettingsView, Sidebar, WorkspaceToolbar } from "./Chrome";
import { observeVisibleTarget } from "../../scripts/browser-readiness.mts";
import { prepareCaptureTarget } from "../../test/capture-target";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

it.for([240, 320, 960])(
  "keeps newly missing source requirements within the Settings viewport at %ipx",
  async (width) => {
    await page.viewport(width, width === 960 ? 640 : 160);
    expect(innerWidth).toBe(width);
    const port = {
      ...portDefinition(),
      name: "Jak and Daxter: The Precursor Legacy · OpenGOAL: Jak and Daxter",
    };
    const profile = {
      ...sourceProfile(),
      label: "Jak and Daxter retail disc validated by the pinned OpenGOAL extractor",
    };
    const registered = {
      profile_id: profile.id,
      path: "D:/Owned game files/source.iso",
      sha256: "a".repeat(64),
      size: 1024,
      storage_sha256: "a".repeat(64),
      storage_size: 1024,
      updated_at: 1,
    };
    const addSource = vi.fn();
    const shared = {
      category: "game-files" as const,
      sourceProfiles: [profile],
      sourceRequirementsState: "available" as const,
      installedCount: 1,
      addSource,
    };
    const content = (missing: boolean) => (
      <div className="interface-root">
        <div className="interface-workspace">
          <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)]">
            <aside className="sidebar" aria-hidden="true" />
            <main className="workspace-main min-h-0 w-full min-w-0 overflow-auto">
              <SettingsView
                {...shared}
                sources={missing ? [] : [registered]}
                sourceNeeds={
                  missing
                    ? [
                        {
                          profile,
                          requiredBy: [
                            { portId: port.id, portName: port.name, role: "Game files" },
                          ],
                        },
                      ]
                    : []
                }
              />
            </main>
          </div>
        </div>
      </div>
    );
    const view = await render(content(false));
    const viewport = () => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    });
    expect(viewport().scroll).toBeLessThanOrEqual(viewport().client + 1);
    await view.rerender(content(true));
    await expect
      .element(page.getByRole("button", { name: "Add game files", exact: true }))
      .toBeVisible();
    const measurement = {
      width,
      ...viewport(),
      rows: [
        ...document.querySelectorAll<HTMLElement>(
          ".source-requirements, .source-requirements-heading, .source-requirement",
        ),
      ].map((element) => ({
        className: element.className,
        width: element.getBoundingClientRect().width,
        scroll: element.scrollWidth,
        children: [...element.children].map((child) => ({
          text: child.textContent,
          width: child.getBoundingClientRect().width,
        })),
      })),
    };
    expect(document.querySelectorAll(".source-requirement")).toHaveLength(1);
    for (const row of document.querySelectorAll<HTMLElement>(
      ".source-requirements, .source-requirement",
    )) {
      expect(row.scrollWidth, JSON.stringify(measurement)).toBeLessThanOrEqual(row.clientWidth + 1);
    }
    expect(viewport().scroll, JSON.stringify(measurement)).toBeLessThanOrEqual(
      viewport().client + 1,
    );
    await page.getByRole("button", { name: "Add game files", exact: true }).click();
    expect(addSource).toHaveBeenCalledExactlyOnceWith(profile, false);
    expect(viewport().scroll).toBeLessThanOrEqual(viewport().client + 1);
  },
);

for (const platform of ["Win32", "MacIntel"]) {
  for (const width of [960, 1280]) {
    it(`includes the visible command shortcut in the accessible name on ${platform} at ${width}px`, async () => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await page.viewport(width, 720);
      const onOpenCommands = vi.fn();
      await render(<WorkspaceToolbar view="library" onOpenCommands={onOpenCommands} />);
      const shortcut = platform === "MacIntel" ? "Command K" : "Ctrl K";
      const button = page.getByRole("button", {
        name: `Search games and pages ${shortcut}: open command palette`,
        exact: true,
      });
      await expect.element(button).toBeVisible();
      expect(button.element().textContent).toContain(shortcut);
      await expect.element(button.getByText(shortcut, { exact: true })).toBeVisible();
      const result = await axe.run(button.element(), {
        runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
      });
      expect(result.violations).toEqual([]);
      await button.click();
      expect(onOpenCommands).toHaveBeenCalledTimes(1);
    });
  }
}

it("keeps the actual workspace Commands trigger available on compact detail navigation without a duplicate header trigger", async () => {
  await page.viewport(320, 720);
  const onOpenCommands = vi.fn();
  await render(
    <>
      <WorkspaceToolbar
        view="catalog"
        detailTitle="A long original game and exact port identity"
        onOpenCommands={onOpenCommands}
      />
      <PageHeader view="catalog" query="" setQuery={() => {}} />
    </>,
  );
  const commands = page.getByRole("button", {
    name: /^Search games and pages .*open command palette$/,
  });
  await expect.element(commands).toBeVisible();
  expect(document.querySelectorAll(".command-trigger")).toHaveLength(1);
  expect(document.querySelector('[aria-label="Current location"]')?.textContent).toContain(
    "Discover",
  );
  await commands.click();
  expect(onOpenCommands).toHaveBeenCalledTimes(1);
  const labels = await axe.run(commands.element(), {
    runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
  });
  expect(labels.violations).toEqual([]);
});

it("keeps the Library Add games action on the heading's existing return-focus target", async () => {
  await page.viewport(1280, 720);
  const onAddGames = vi.fn();
  await render(
    <PageHeader
      view="library"
      query=""
      setQuery={() => {}}
      libraryCount={12}
      onAddGames={onAddGames}
    />,
  );
  const add = page.getByRole("button", { name: "Add games", exact: true });
  expect(add.element().hasAttribute("data-add-games-trigger")).toBe(true);
  await add.click();
  expect(onAddGames).toHaveBeenCalledTimes(1);
});

it("retains an explicitly requested standalone PageHeader Commands control", async () => {
  const onOpenCommands = vi.fn();
  await render(
    <PageHeader view="library" query="" setQuery={() => {}} onOpenCommands={onOpenCommands} />,
  );
  await page
    .getByRole("button", { name: /^Search games and pages .*open command palette$/ })
    .click();
  expect(onOpenCommands).toHaveBeenCalledTimes(1);
});

it.for([
  [960, "dark"],
  [960, "light"],
  [1280, "dark"],
  [1280, "light"],
] as const)(
  "keeps primary destinations reachable without task tools competing in the sidebar at %spx in %s",
  async ([width, theme]) => {
    await page.viewport(width, 640);
    document.documentElement.dataset.theme = theme;
    const setView = vi.fn();
    await render(
      <Sidebar
        view="library"
        setView={setView}
        installedCount={3}
        updateCount={0}
        activities={[]}
      />,
    );
    expect(document.querySelector(".sidebar-footer")?.textContent ?? "").not.toContain(
      "Copy existing installation",
    );
    for (const label of ["Library", "Discover", "Activity", "Settings"])
      await expect
        .element(page.getByRole("button", { name: new RegExp(`^${label}`) }))
        .toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(setView).toHaveBeenCalledWith("settings");
  },
);

it("visual capture accepts decorative art, rejects hidden and clipped ancestors, and reveals nested targets", async () => {
  await page.viewport(960, 640);
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:200px;top:100px;width:220.25px;height:120.25px;overflow:auto;border:1px solid black;box-sizing:content-box";
  host.innerHTML =
    '<div style="height:400px;padding-top:250px"><div data-visual-fixture aria-hidden="true" style="width:100px;height:40px;background:red"></div></div>';
  document.body.append(host);
  const element = host.querySelector<HTMLElement>("[data-visual-fixture]")!;
  const target = "[data-visual-fixture]";
  const prepare = () =>
    prepareCaptureTarget({
      target,
      label: "nested-visual-fixture",
      scroll: () => element.scrollIntoView({ block: "center", behavior: "instant" }),
      observe: () => observeVisibleTarget(target, "visual"),
    });
  try {
    expect(observeVisibleTarget(target, "visual").visible).toBe(false);
    const result = await prepare();
    expect(result.observation.visible).toBe(true);
    expect(host.scrollTop).toBeGreaterThan(0);
    expect(observeVisibleTarget(target).visible).toBe(false);
    host.hidden = true;
    await expect(prepare()).rejects.toThrow("Capture target geometry must be finite and nonzero");
    host.hidden = false;
    host.style.opacity = "0";
    await expect(prepare()).rejects.toThrow("Capture requires one identified visible target");
    host.style.opacity = "1";
    element.style.height = "180px";
    await expect(prepare()).rejects.toThrow("Capture requires one identified visible target");
  } finally {
    host.remove();
  }
});

for (const count of [1, 2]) {
  it(`opens the correct Steam review workflow for ${count} installed entries and restores focus`, async () => {
    await render(
      <SettingsView
        category="integrations"
        steamPorts={Array.from({ length: count }, (_, index) => ({
          ...portDefinition(),
          id: `steam-${index}`,
        }))}
      />,
    );
    const trigger = page.getByRole("button", { name: "Choose games for Steam…", exact: true });
    await trigger.click();
    await expect
      .element(
        page.getByRole("heading", {
          name: count === 1 ? "Manage Steam shortcut" : "Add selected games to Steam",
          exact: true,
        }),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(trigger).toHaveFocus();
  });
}
