import { controlledAct as act } from "../../test/controlled-react-act";
import { captureParityState } from "../../test/parity-capture";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import type {
  ListingDeliveryStatus,
  OfficialCatalogAutomaticRefresh,
  OfficialCatalogReview,
  OperationEvent,
} from "../types";
import {
  resetAutomaticCatalogCheck,
  useOfficialCatalogAutoRefresh,
} from "../features/catalog-updates/use-official-catalog-auto-refresh";
import { OfficialCatalogUpdates } from "./OfficialCatalogUpdates";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const configured: OfficialCatalogReview = {
  configured: true,
  enabled: false,
  source: {
    metadata_base_url: "https://catalog.invalid/metadata/",
    targets_base_url: "https://catalog.invalid/targets/",
  },
  expected_plan: "a".repeat(64),
};
const unavailable: OfficialCatalogReview = {
  configured: false,
  enabled: false,
  source: null,
  expected_plan: null,
};
const delivered: ListingDeliveryStatus = {
  delivery_schema: 1,
  selected: true,
  revision: 1,
  anchor_sha256: "c".repeat(64),
  repository_root_sha256: "d".repeat(64),
  target_sha256: "e".repeat(64),
  expires_at: "2030-01-01T00:00:00Z",
  listing_count: 1,
  withdrawn_ids: [],
  fallback_reason: null,
};
const notServed: OfficialCatalogAutomaticRefresh = {
  outcome: "unavailable",
  serving: "not_served",
  status: null,
};
const started: OperationEvent = {
  schema_version: 2,
  operation_id: "owned-catalog-refresh",
  parent_operation_id: null,
  target: null,
  sequence: 1,
  timestamp_ms: 1,
  operation: "update_catalog",
  type: "started",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

let root: Root;
let host: HTMLDivElement;
const changed = vi.fn<() => Promise<unknown>>();
const automaticBox = () => page.getByRole("checkbox", { name: "Update the catalog automatically" });
const refreshButton = () =>
  page.getByRole("button", { name: "Refresh official catalog", exact: true });

function Scheduled({ generation, busy }: { generation: number; busy: boolean }) {
  useOfficialCatalogAutoRefresh(generation, true, busy, changed);
  return <OfficialCatalogUpdates generation={generation} disabled={busy} onChanged={changed} />;
}

async function render(generation = 7, disabled = false) {
  await act(async () =>
    root.render(
      <OfficialCatalogUpdates generation={generation} disabled={disabled} onChanged={changed} />,
    ),
  );
}
async function renderScheduled(generation = 7, busy = false) {
  await act(async () => root.render(<Scheduled generation={generation} busy={busy} />));
}
async function click(target: Parameters<typeof userEvent.click>[0]) {
  await act(async () => userEvent.click(target));
}
async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}
// Vitest advances fake timers while Playwright actions and element polling are
// pending, so scheduled-check tests dispatch clicks and read text directly.
async function toggleAutomatic() {
  await act(async () => host.querySelector<HTMLElement>("[role=checkbox]")!.click());
}
const automaticChecked = () =>
  host.querySelector("[role=checkbox]")?.getAttribute("aria-checked") === "true";
const automaticCalls = () => vi.mocked(desktopApi.refreshOfficialCatalogAutomatically).mock.calls;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetAutomaticCatalogCheck();
  changed.mockReset().mockResolvedValue(undefined);
  vi.spyOn(desktopApi, "officialCatalogReview").mockResolvedValue(configured);
  vi.spyOn(desktopApi, "officialCatalogAutomaticUpdates").mockResolvedValue(true);
  vi.spyOn(desktopApi, "setOfficialCatalogAutomaticUpdates").mockImplementation(
    async (enabled) => enabled,
  );
  vi.spyOn(desktopApi, "refreshOfficialCatalog").mockResolvedValue(delivered);
  vi.spyOn(desktopApi, "refreshOfficialCatalogAutomatically").mockResolvedValue(notServed);
  vi.spyOn(desktopApi, "cancelOperation").mockResolvedValue({
    requested: true,
    phase: "preparing",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps unconfigured releases inert without asking for trust bytes or addresses", async () => {
  vi.mocked(desktopApi.officialCatalogReview).mockResolvedValue(unavailable);
  await render();
  await expect
    .element(page.getByText("Official catalog updates are unavailable in this release."))
    .toBeVisible();
  expect(host.querySelectorAll("input")).toHaveLength(0);
  expect(host.querySelectorAll("[role=checkbox]")).toHaveLength(0);
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
});

it("shows automatic updates on by default and refreshes on request without a confirmation", async () => {
  await render();
  await expect.element(automaticBox()).toBeChecked();
  await expect
    .element(page.getByText("Portcove checks for catalog updates shortly after it opens."))
    .toBeVisible();
  await captureParityState("official-catalog-automatic-updates");
  await click(refreshButton());
  expect(desktopApi.refreshOfficialCatalog).toHaveBeenCalledExactlyOnceWith(
    7,
    expect.any(Function),
  );
  expect(changed).toHaveBeenCalledOnce();
  await expect.element(page.getByText("Official catalog refreshed.")).toBeVisible();
  expect(page.getByRole("dialog").query()).toBeNull();
});

it("saves an explicit off and on, and asks for a check soon after turning updates on", async () => {
  vi.mocked(desktopApi.officialCatalogAutomaticUpdates).mockResolvedValue(false);
  await render();
  await expect.element(automaticBox()).not.toBeChecked();
  await expect
    .element(
      page.getByText("Automatic updates are off. Choose Refresh official catalog to check now."),
    )
    .toBeVisible();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(desktopApi.refreshOfficialCatalogAutomatically).mockResolvedValue({
    outcome: "turned_off",
    serving: null,
    status: null,
  });
  await renderScheduled();
  await advance(16_000);
  expect(automaticCalls()).toHaveLength(1);
  expect(automaticChecked()).toBe(false);
  await toggleAutomatic();
  expect(desktopApi.setOfficialCatalogAutomaticUpdates).toHaveBeenLastCalledWith(true);
  expect(automaticChecked()).toBe(true);
  // The next check comes soon, not a day later.
  await advance(2_000);
  expect(automaticCalls()).toHaveLength(2);
  await toggleAutomatic();
  expect(desktopApi.setOfficialCatalogAutomaticUpdates).toHaveBeenLastCalledWith(false);
  expect(automaticChecked()).toBe(false);
  await advance(2_000);
  expect(automaticCalls()).toHaveLength(2);
});

it("reports a lost choice reply without guessing what was saved", async () => {
  vi.mocked(desktopApi.setOfficialCatalogAutomaticUpdates).mockRejectedValue(
    new Error("reply lost"),
  );
  await render();
  await click(automaticBox());
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Portcove couldn’t confirm that your choice was saved. Reload catalog settings to check.",
    );
  await expect.element(automaticBox()).toBeChecked();
});

it("checks shortly after startup and then daily, quietly reporting an unpublished catalog", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await renderScheduled();
  await advance(14_000);
  expect(automaticCalls()).toHaveLength(0);
  await advance(2_000);
  expect(automaticCalls()).toEqual([[7, expect.any(Function)]]);
  expect(host.textContent).toContain("No catalog updates have been published yet.");
  expect(host.querySelector("[role=alert]")).toBeNull();
  expect(changed).not.toHaveBeenCalled();

  vi.mocked(desktopApi.refreshOfficialCatalogAutomatically).mockResolvedValue({
    outcome: "refreshed",
    serving: null,
    status: delivered,
  });
  await advance(23 * 60 * 60 * 1000);
  expect(automaticCalls()).toHaveLength(1);
  await advance(60 * 60 * 1000);
  expect(automaticCalls()).toHaveLength(2);
  expect(changed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Your catalog is up to date.");
});

it("never overlaps checks and waits while another task is using the library", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = deferred<OfficialCatalogAutomaticRefresh>();
  vi.mocked(desktopApi.refreshOfficialCatalogAutomatically).mockReturnValue(pending.promise);
  await renderScheduled(7, true);
  await advance(16_000);
  expect(automaticCalls()).toHaveLength(0);
  await renderScheduled(7, false);
  await advance(60_000);
  expect(automaticCalls()).toHaveLength(1);
  // Turning updates on asks for a check while one is still running.
  await toggleAutomatic();
  await toggleAutomatic();
  expect(automaticChecked()).toBe(true);
  await advance(120_000);
  expect(automaticCalls()).toHaveLength(1);
  await act(async () => pending.resolve(notServed));
  // The request made during that check is answered soon after it finishes.
  vi.mocked(desktopApi.refreshOfficialCatalogAutomatically).mockResolvedValue(notServed);
  await advance(2_000);
  expect(automaticCalls()).toHaveLength(2);
  await advance(60 * 60 * 1000);
  expect(automaticCalls()).toHaveLength(2);
});

it("shows a player's successful refresh as the latest check", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await renderScheduled();
  await advance(16_000);
  expect(host.textContent).toContain("No catalog updates have been published yet.");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Refresh official catalog")!
      .click(),
  );
  expect(desktopApi.refreshOfficialCatalog).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Official catalog refreshed.");
  expect(host.textContent).toContain("Your catalog is up to date.");
  expect(host.textContent).not.toContain("No catalog updates have been published yet.");
});

it("keeps Refresh available when only the automatic-update choice cannot be read", async () => {
  vi.mocked(desktopApi.officialCatalogAutomaticUpdates).mockRejectedValue(
    new Error("preferences unreadable"),
  );
  await render();
  await expect.element(refreshButton()).toBeEnabled();
  await expect.element(page.getByRole("alert")).toHaveTextContent("preferences unreadable");
  expect(host.querySelector("[role=checkbox]")).toBeNull();
});

it("keeps failures quiet, keeps the current catalog and tries again the next day", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(desktopApi.refreshOfficialCatalogAutomatically).mockRejectedValueOnce(
    new Error("offline"),
  );
  await renderScheduled();
  await advance(16_000);
  expect(host.textContent).toContain(
    "Your current catalog stays in use, and Portcove will try again later.",
  );
  expect(host.querySelector("[role=alert]")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  await advance(24 * 60 * 60 * 1000);
  expect(automaticCalls()).toHaveLength(2);
});

it("cancels the owned refresh and keeps the controls for a later retry", async () => {
  const pending = deferred<ListingDeliveryStatus>();
  vi.mocked(desktopApi.refreshOfficialCatalog).mockImplementation((_generation, report) => {
    report(started);
    return pending.promise;
  });
  await render();
  await click(refreshButton());
  await expect.element(page.getByRole("button", { name: "Cancel catalog refresh" })).toBeEnabled();
  await click(page.getByRole("button", { name: "Cancel catalog refresh" }));
  expect(desktopApi.cancelOperation).toHaveBeenCalledExactlyOnceWith("owned-catalog-refresh");
  await act(async () => pending.reject({ code: "cancelled" }));
  await expect.element(page.getByText("Catalog refresh cancelled.")).toBeVisible();
  await expect.element(refreshButton()).toBeEnabled();
});

it("drops old refresh events and readback after a library generation change", async () => {
  const pending = deferred<ListingDeliveryStatus>();
  let report!: (event: OperationEvent) => void;
  vi.mocked(desktopApi.officialCatalogReview).mockImplementation(async (generation) =>
    generation === 7 ? configured : unavailable,
  );
  vi.mocked(desktopApi.refreshOfficialCatalog).mockImplementation((_generation, callback) => {
    report = callback;
    return pending.promise;
  });
  await render();
  await click(refreshButton());
  await render(8);
  await act(async () => {
    report(started);
    pending.resolve(delivered);
  });
  await expect
    .element(page.getByText("Official catalog updates are unavailable in this release."))
    .toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Cancel catalog refresh");
  expect(document.body.textContent).not.toContain("Official catalog refreshed.");
});

it("keeps loading and externally disabled controls nonmutating", async () => {
  const pending = deferred<OfficialCatalogReview>();
  vi.mocked(desktopApi.officialCatalogReview).mockReturnValue(pending.promise);
  await render(7, true);
  await expect.element(page.getByText("Loading catalog settings…")).toBeVisible();
  await act(async () => pending.resolve(configured));
  await expect.element(refreshButton()).toBeDisabled();
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
  expect(desktopApi.setOfficialCatalogAutomaticUpdates).not.toHaveBeenCalled();
});
