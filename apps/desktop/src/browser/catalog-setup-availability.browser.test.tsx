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
const externalUnavailable = {
  action: "register_external",
  availability: "not_offered",
  reason: "route_not_offered",
} as const;
const cases = [
  {
    name: "Unknown game",
    label: "Setup status unknown",
    actions: undefined,
    reason: "Managed setup: Setup status unknown",
  },
  {
    name: "Held game",
    label: "Setup on hold",
    actions: [
      {
        action: "install",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "source_identity_mismatch" },
      },
      externalUnavailable,
    ],
    reason: "The game files do not match the required edition",
  },
  {
    name: "Files game",
    label: "Setup needs review",
    actions: [
      { action: "install", availability: "waiting", reason: "missing_source" },
      externalUnavailable,
    ],
    reason: "Required game files are missing",
  },
  {
    name: "BIOS game",
    label: "Setup needs review",
    actions: [
      { action: "install", availability: "waiting", reason: "missing_bios" },
      externalUnavailable,
    ],
    reason: "A required BIOS file is missing",
  },
  {
    name: "External game",
    label: "Setup needs review",
    actions: [
      { action: "install", availability: "not_offered", reason: "route_not_offered" },
      { action: "register_external", availability: "waiting", reason: "review_required" },
    ],
    reason: "External updates remain yours to manage",
  },
  {
    name: "Eligible game",
    label: "Setup available",
    actions: [
      { action: "install", availability: "allowed", reason: "available" },
      externalUnavailable,
    ],
    reason: "Current setup checks passed",
  },
] as const;
const ports = cases.map(({ name }) => ({ ...portDefinition(), id: name, name }));
const statuses = new Map<string, PortStatus>(
  cases.map((entry) => [
    entry.name,
    {
      ...portStatus(),
      port_id: entry.name,
      ...(entry.actions ? { port_actions: [...entry.actions] } : {}),
    },
  ]),
);
let host: HTMLDivElement;
let root: Root;
function Fixture() {
  const [selected, setSelected] = useState<string>();
  return (
    <DirectionProvider direction="ltr">
      {selected ? (
        <main>
          <h1>Details for {selected}</h1>
          <button onClick={() => setSelected(undefined)}>Back to catalog</button>
        </main>
      ) : (
        <PortBrowser
          view="catalog"
          ports={ports}
          statuses={statuses}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={setSelected}
          loading={false}
        />
      )}
    </DirectionProvider>
  );
}
beforeEach(() => {
  invoke.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
});
it.each(["dark", "light"])("keeps cached setup reasons and Details access in %s", async (theme) => {
  await page.viewport(960, 720);
  document.documentElement.dataset.theme = theme;
  flushSync(() => root.render(<Fixture />));
  for (const item of cases) {
    const card = page.getByRole("button", {
      name: new RegExp(`^${item.name}\\s+${item.label}\\b`),
    });
    await expect.element(card).toBeEnabled();
    await expect.element(card).toHaveAccessibleName(/\bView details$/);
    await expect.element(card).toMatchTextContent("View details");
    await expect.element(card).toMatchTextContent(item.reason);
    await expect.element(card).toHaveAccessibleDescription(new RegExp(item.reason));
    await expect.element(card).toMatchTextContent(/Not installed/);
    await expect.element(card).not.toMatchTextContent(/Ready to play/);
    await userEvent.click(card);
    await expect
      .element(page.getByRole("heading", { name: `Details for ${item.name}`, exact: true }))
      .toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Back to catalog", exact: true }));
  }
  expect(invoke).not.toHaveBeenCalled();
});
