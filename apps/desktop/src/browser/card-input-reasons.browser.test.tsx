import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { PortBrowser } from "../components/PortBrowser";
import { portDefinition, portStatus } from "../test-fixtures";
import type { PortStatus } from "../types";
import "../styles/index.css";
const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../api", () => ({ desktopApi: new Proxy({}, { get: () => invoke }) }));
const launch = vi.fn();
const install: NonNullable<PortStatus["active"]> = {
  id: "install",
  port_id: "sample",
  channel: "stable",
  version: "1",
  path: "/fixture",
  installed_at: 1,
  staged: false,
  verified: true,
  manifest_sha256: "a".repeat(64),
  selected_executable: "game.exe",
  runtime: null,
  artifact: { asset_name: "fixture.zip", size: 1, sha256: "a".repeat(64) },
};
const cases = [
  ["Missing files", "Game files missing", ["missing_source"], "Required game files are missing"],
  ["Changed files", "Game files changed", ["changed_source"], "game files changed"],
  ["Unreadable files", "Game files unreadable", ["unreadable_source"], "restore access"],
  ["Missing BIOS", "BIOS file missing", ["missing_bios"], "BIOS file is missing"],
  ["Changed BIOS", "BIOS file changed", ["changed_bios"], "BIOS file changed"],
  ["Unreadable BIOS", "BIOS file unreadable", ["unreadable_bios"], "restore access"],
  [
    "Compound inputs",
    "Game files and BIOS need review",
    ["changed_source", "missing_bios"],
    "BIOS file is missing",
  ],
  ["Wrong edition", "Input edition mismatch", [], "do not match the required edition"],
] as const;
const ports = [...cases.map(([name]) => name), "Unknown", "Ready", "Staged ready"].map((name) => ({
  ...portDefinition(),
  id: name,
  name,
}));
const statuses = new Map<string, PortStatus>(
  ports.map((port, index) => {
    const problem = cases[index];
    const ready = port.id === "Ready" || port.id === "Staged ready";
    return [
      port.id,
      {
        ...portStatus(),
        port_id: port.id,
        channel: "beta",
        active: { ...install, port_id: port.id },
        ...(port.id === "Unknown"
          ? {}
          : {
              readiness: {
                launchable: ready,
                pending_setup: false,
                blockers: problem ? [...problem[2]] : [],
              },
            }),
        staged:
          port.id === "Staged ready"
            ? { ...install, port_id: port.id, staged: true, version: "2" }
            : null,
        ...(port.id === "Wrong edition"
          ? {
              port_actions: [
                {
                  action: "launch",
                  availability: "held",
                  reason: "definition_ineligible",
                  definition: { outcome: "hold", reason: "source_identity_mismatch" },
                },
              ],
            }
          : {}),
      },
    ];
  }),
);
let host: HTMLDivElement;
let root: Root;
function Fixture({ view }: { view: "library" | "catalog" }) {
  const [selected, setSelected] = useState<string>();
  return (
    <DirectionProvider direction="ltr">
      {selected ? (
        <main>
          <h1>Details for {selected}</h1>
          <button onClick={() => setSelected(undefined)}>Back to cards</button>
        </main>
      ) : (
        <PortBrowser
          view={view}
          ports={ports}
          statuses={statuses}
          overview={{ installed: ports.length, ready: 2, needsSetup: ports.length - 2, staged: 1 }}
          filter="all"
          setFilter={() => {}}
          onSelect={setSelected}
          onContinue={launch}
          loading={false}
        />
      )}
    </DirectionProvider>
  );
}
beforeEach(() => {
  invoke.mockClear();
  launch.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
});
function gameCard(name: string) {
  return page.getByRole("article").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}
it("keeps a legacy required-input card unconfirmed when health and assessment are absent", async () => {
  const port = { ...portDefinition(), source_profile: "original" };
  const status = {
    ...portStatus(),
    active: install,
    readiness: { launchable: true, pending_setup: false, blockers: [] },
  };
  flushSync(() =>
    root.render(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={() => {}}
        onSelect={() => {}}
        onContinue={launch}
        loading={false}
      />,
    ),
  );
  const card = page.getByRole("article");
  await expect.element(card).toMatchTextContent("Compatibility unconfirmed");
  await expect.element(card).not.toMatchTextContent("Ready to play");
  await userEvent.click(card.getByRole("button", { name: "Try launch", exact: true }));
  expect(launch).toHaveBeenCalledWith(port.id);
});
it.each([
  ["catalog", "dark"],
  ["catalog", "light"],
  ["library", "dark"],
  ["library", "light"],
] as const)(
  "shows authoritative installed input reasons and Details in %s/%s",
  async (view, theme) => {
    await page.viewport(960, 720);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture view={view} />));
    for (const [name, label, , reason] of cases) {
      const card = gameCard(name);
      await expect.element(card).toHaveAccessibleName(new RegExp(`^${name}.*${label}`));
      expect(card.element().querySelector(".readiness")?.textContent?.trim()).toBe(label);
      await expect.element(card).toMatchTextContent(reason);
      await expect.element(card).toHaveAccessibleDescription(new RegExp(reason));
      await expect.element(card).toMatchTextContent("Selected update channel: Preview");
      await expect.element(card.getByText("Stable", { exact: true })).toBeVisible();
      await expect
        .element(card.getByRole("button", { name: "Play", exact: true }))
        .not.toBeInTheDocument();
      const details =
        view === "library"
          ? page.getByRole("button", {
              name: `View details for ${name} ${name}`,
              exact: true,
            })
          : card
              .getByRole("button")
              .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect.element(details).toBeEnabled();
      await expect.element(details).toHaveAccessibleDescription(new RegExp(reason));
      await userEvent.click(details);
      await expect
        .element(page.getByRole("heading", { name: `Details for ${name}`, exact: true }))
        .toBeInTheDocument();
      await userEvent.click(page.getByRole("button", { name: "Back to cards", exact: true }));
    }
    await expect.element(gameCard("Unknown")).toHaveAccessibleName(/Readiness unavailable/);
    for (const name of ["Ready", "Staged ready"]) {
      const card = gameCard(name);
      expect(card.element().querySelector(".readiness")?.textContent?.trim()).toBe("Ready to play");
      await expect.element(card).not.toHaveAccessibleDescription();
      const play = card.getByRole("button", { name: "Play", exact: true });
      await expect
        .poll(() => play.query()?.matches(":disabled") ?? null)
        .toBe(view === "library" ? false : null);
      if (view === "library") await userEvent.click(play);
      await expect
        .element(card)
        .toMatchTextContent(
          name === "Staged ready"
            ? view === "library"
              ? "Update prepared"
              : "Update prepared"
            : "Ready to play",
        );
    }
    expect(launch).toHaveBeenCalledTimes(view === "library" ? 2 : 0);
    expect(invoke).not.toHaveBeenCalled();
  },
);
