// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { DetailPanel, type DetailActions } from "./components/DetailPanel";
import { PortBrowser } from "./components/PortBrowser";
import { portDefinition, portStatus } from "./test-fixtures";
import type { PortStatus, ReadinessBlocker } from "./types";
import { filterPorts, portReadiness, summarizeLibrary } from "./view-model";

const port = { ...portDefinition(), source_profile: "owned-source" };
const installed = (readiness?: PortStatus["readiness"]): PortStatus => ({ ...portStatus(), active: {
  id: "owned-install", port_id: port.id, version: "1.0", path: "D:/Library/versions/owned", channel: "stable", installed_at: 1, verified: true, staged: false,
  artifact: { asset_name: "owned.zip", sha256: "a".repeat(64), size: 1 }, manifest_sha256: "b".repeat(64), selected_executable: "game.exe", runtime: null,
}, readiness, last_launched_at: 1, successful_launches: 1 });
const actions: DetailActions = { activate: vi.fn(), backup: vi.fn(), check: vi.fn(), close: vi.fn(), deleteBackup: vi.fn(), install: vi.fn(), launch: vi.fn(), openUserData: vi.fn(), reviewInstall: vi.fn(), remove: vi.fn(), restoreBackup: vi.fn(), rollback: vi.fn(), setChannel: vi.fn(), setPolicy: vi.fn(), verify: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([undefined, null])("keeps an installed game out of Ready when the core assessment is %s", readiness => {
  const status = installed(readiness); const statuses = new Map([[port.id, status]]);
  expect(portReadiness(status)).toBe("unknown");
  expect(filterPorts([port], statuses, "library", "ready", "")).toEqual([]);
  expect(filterPorts([port], statuses, "library", "setup", "")).toEqual([port]);
  expect(summarizeLibrary([port], statuses)).toEqual({ installed: 1, ready: 0, needsSetup: 1, staged: 0 });
});

it.each([{ blockers: [] }, { blockers: ["future_blocker" as ReadinessBlocker] }])("preserves a core launch refusal without recognized blockers: $blockers", ({ blockers }) => {
  const status = installed({ launchable: false, pending_setup: false, blockers });
  expect(portReadiness({ ...status, staged: status.active })).toBe("blocked");
});

it.each([true, false])("does not offer Play for a missing assessment with source requirement %s", requiresSource => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<DetailPanel port={{ ...port, source_profile: requiresSource ? "owned-source" : null }} status={installed()} sourcePath="D:/Selected/game.z64" setSourcePath={vi.fn()} actions={actions} />);
  const primary = host.querySelector<HTMLButtonElement>(".primary-actions button")!;
  expect(primary.disabled).toBe(true);
  expect(primary.textContent).not.toContain("Choose required source");
  expect(host.textContent).toContain("Readiness unavailable");
  expect(host.textContent).not.toContain("Ready to launch");
});

it.each([undefined, null, { launchable: false, pending_setup: false, blockers: [] }])("routes Continue to review without a positive core launch decision: %s", async readiness => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host); const launch = vi.fn(); const details = vi.fn();
  const status = installed(readiness); const statuses = new Map([[port.id, status]]);
  try {
    await act(async () => root.render(<PortBrowser view="library" ports={[port]} statuses={statuses} overview={summarizeLibrary([port], statuses)}
      recent={{ port, status }} filter="all" setFilter={vi.fn()} onSelect={details} onContinue={launch} loading={false} />));
    await act(async () => host.querySelector<HTMLButtonElement>(".continue-actions button.primary")!.click());
    expect(launch).not.toHaveBeenCalled();
    expect(details).toHaveBeenCalledExactlyOnceWith(port.id);
    expect(host.querySelector(".continue-actions")?.textContent).not.toContain("Play again");
  } finally { await act(async () => root.unmount()); }
});

it("restores Continue only after a new positive core assessment without changing the records", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host); const launch = vi.fn(); const details = vi.fn();
  const unknown = installed(); const ready = installed({ launchable: true, pending_setup: false, blockers: [], source: "current" });
  const original = JSON.stringify([unknown, ready]);
  const render = async (status: PortStatus) => act(async () => root.render(<PortBrowser view="library" ports={[port]} statuses={new Map([[port.id, status]])} overview={summarizeLibrary([port], new Map([[port.id, status]]))}
    recent={{ port, status }} filter="all" setFilter={vi.fn()} onSelect={details} onContinue={launch} loading={false} />));
  try {
    await render(unknown);
    await act(async () => host.querySelector<HTMLButtonElement>(".continue-actions button.primary")!.click());
    expect(launch).not.toHaveBeenCalled();
    await render(ready);
    expect(host.querySelector(".continue-actions button.primary")?.textContent).toBe("Play again");
    await act(async () => host.querySelector<HTMLButtonElement>(".continue-actions button.primary")!.click());
    expect(launch).toHaveBeenCalledExactlyOnceWith(port.id);
    expect(details).toHaveBeenCalledExactlyOnceWith(port.id);
    expect(JSON.stringify([unknown, ready])).toBe(original);
  } finally { await act(async () => root.unmount()); }
});
