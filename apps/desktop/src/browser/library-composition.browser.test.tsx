import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { PortBrowser } from "../components/PortBrowser";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { portDefinition, portStatus } from "../test-fixtures";
import type { ExternalRuntimeRecord } from "../types";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  document.getElementById("root")?.remove();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
  delete document.documentElement.dataset.theme;
});

async function mount(theme = "dark", journey: "collection" | "collection-large" = "collection") {
  localStorage.clear();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  transport = installInteractiveTransport(journey, (message) => {
    throw Error(message);
  });
  initializeLocalization(["en"]);
  document.documentElement.dataset.theme = theme;
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect
    .poll(() => document.querySelectorAll(".collection-entry").length)
    .toBe(journey === "collection-large" ? 60 : 12);
}

it("groups retrieval, preserves independent duplicate-port launch targets and states the Steam selection scope", async () => {
  await page.viewport(1366, 768);
  await mount();
  const launch = vi.spyOn(desktopApi, "launch");
  expect(document.querySelector(".library-query-tools #port-search")).not.toBeNull();
  expect(document.querySelector(".header-tools #port-search")).toBeNull();
  expect(document.body.textContent).toContain("12 entries · On this computer");
  const plays = page
    .getByRole("region", { name: "Library entries" })
    .getByRole("button", { name: "Play", exact: true });
  await plays.nth(0).click();
  await expect.poll(() => launch.mock.calls[0]).toEqual(["collection-0", "", 1]);
  await plays.nth(1).click();
  await expect.poll(() => launch.mock.calls[1]).toEqual(["collection-1", "", 1]);
  await page.getByRole("textbox", { name: "Search your library" }).fill("Super Mario 64");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  expect(document.body.textContent).toContain("2 of 12 library entries");
  const commands = document.querySelector<HTMLDetailsElement>(".library-query-tools details")!;
  commands.open = true;
  expect(commands.textContent).toContain("12 installed entries");
  expect(commands.textContent).toContain("hidden by filters");
  await page.getByRole("button", { name: "Clear search and filters", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  const more = page.getByRole("button", { name: /^More actions for/ }).first();
  await more.click();
  await userEvent.keyboard("{End}");
  await expect.element(page.getByRole("menuitem", { name: "Saves and storage" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(more).toHaveFocus();
});

for (const theme of ["dark", "light"]) {
  it(`keeps ${theme} scrolled row action focus and browsing context through live resizing`, async () => {
    await page.viewport(1366, 768);
    await mount(theme, "collection-large");
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    await page.getByRole("textbox", { name: "Search your library" }).fill("a");
    const count = document.querySelectorAll(".collection-entry").length;
    const action = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".collection-actions button[data-variant=primary]",
      ),
    ].at(-1)!;
    action.focus();
    action.scrollIntoView({ block: "center" });
    const main = document.querySelector<HTMLElement>(".app-shell > main")!;
    expect(main.scrollTop).toBeGreaterThan(0);
    for (const [width, height] of [
      [1920, 1080],
      [960, 640],
      [1366, 768],
    ]) {
      await page.viewport(width!, height!);
      expect(document.activeElement).toBe(action);
      expect(document.querySelectorAll(".collection-row")).toHaveLength(count);
      expect((document.getElementById("port-search") as HTMLInputElement).value).toBe("a");
      expect(Math.abs(main.getBoundingClientRect().right - innerWidth)).toBeLessThanOrEqual(1);
      expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
      expect(getComputedStyle(main).overflowY).toBe("auto");
      action.scrollIntoView({ block: "nearest" });
      const box = action.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(innerHeight + 1);
    }
  });

  it(`connects enlarged ${theme} row identity and readiness without an inset in a separate column`, async () => {
    await page.viewport(1366, 768);
    document.documentElement.style.fontSize = "200%";
    await mount(theme);
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    const row = document.querySelector<HTMLElement>(".collection-row")!;
    const identity = row.querySelector<HTMLElement>(".collection-identity")!;
    const state = row.querySelector<HTMLElement>(".collection-state")!;
    const ready = state.querySelector<HTMLElement>(".readiness")!;
    expect(getComputedStyle(document.documentElement).fontSize).toBe("32px");
    expect(ready.textContent).toContain("Ready to play");
    const range = document.createRange();
    range.selectNodeContents(ready.lastChild!);
    expect(range.getClientRects()).toHaveLength(1);
    const inset = parseFloat(getComputedStyle(state).paddingInlineStart);
    expect(
      inset === 0 || state.getBoundingClientRect().top >= identity.getBoundingClientRect().bottom,
    ).toBe(true);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  });
}

it("keeps an unknown external record distinct from managed readiness and reviews its stable port", async () => {
  const port = portDefinition();
  const record: ExternalRuntimeRecord = {
    id: "external-observed",
    port_id: port.id,
    path: "C:\\Player\\External",
    executable: "C:\\Player\\External\\game.exe",
    version: "1",
    platform: "windows-x86-64",
    archive_sha256: "a".repeat(64),
    immutable_tree_sha256: "b".repeat(64),
    registered_at: 1,
  };
  const status = { ...portStatus(), external_runtime: record };
  const select = vi.fn(),
    launch = vi.fn();
  await render(
    <PortBrowser
      view="library"
      ports={[port]}
      statuses={new Map([[port.id, status]])}
      overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
      filter="all"
      setFilter={() => {}}
      onSelect={select}
      onContinue={launch}
      loading={false}
    />,
  );
  expect(document.querySelector(".collection-state")?.textContent).toContain(
    "Readiness unavailable",
  );
  expect(page.getByRole("button", { name: "Play", exact: true }).query()).toBeNull();
  await page.getByRole("button", { name: /^Review game:/ }).click();
  expect(select).toHaveBeenCalledWith(port.id, `library:card:${port.id}:review`);
  expect(status.external_runtime).toBe(record);
  expect(status.active).toBeNull();
  expect(record.path).toBe("C:\\Player\\External");
  expect(launch).not.toHaveBeenCalled();
});
