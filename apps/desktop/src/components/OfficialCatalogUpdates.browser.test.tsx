import { controlledAct as act } from "../../test/controlled-react-act";
import { captureParityState } from "../../test/parity-capture";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import type {
  ListingDeliveryStatus,
  OfficialCatalogReview,
  OfficialCatalogSetup,
  OperationEvent,
} from "../types";
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
const enabled: OfficialCatalogReview = {
  ...configured,
  enabled: true,
  expected_plan: "b".repeat(64),
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
const enableButton = () =>
  page.getByRole("button", { name: "Enable official catalog updates", exact: true });
const confirmButton = () => page.getByRole("button", { name: "Enable updates", exact: true });
const refreshButton = () =>
  page.getByRole("button", { name: "Refresh official catalog", exact: true });

async function render(generation = 7, disabled = false) {
  await act(async () =>
    root.render(
      <OfficialCatalogUpdates generation={generation} disabled={disabled} onChanged={changed} />,
    ),
  );
}
async function click(target: Parameters<typeof userEvent.click>[0]) {
  await act(async () => userEvent.click(target));
}

async function confirm() {
  await click(enableButton());
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await click(confirmButton());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  changed.mockReset().mockResolvedValue(undefined);
  vi.spyOn(desktopApi, "officialCatalogReview").mockResolvedValue(configured);
  vi.spyOn(desktopApi, "enableOfficialCatalog").mockResolvedValue({
    changed: true,
    review: enabled,
  });
  vi.spyOn(desktopApi, "refreshOfficialCatalog").mockResolvedValue(delivered);
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
  expect(desktopApi.enableOfficialCatalog).not.toHaveBeenCalled();
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
});

it("requires accessible explicit confirmation, then enables and refreshes the fixed source", async () => {
  await render();
  await expect.element(enableButton()).toBeEnabled();
  await click(enableButton());
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(desktopApi.enableOfficialCatalog).not.toHaveBeenCalled();
  await captureParityState("official-catalog-confirmation");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .poll(() => document.activeElement?.textContent)
    .toBe("Enable official catalog updates");
  expect(desktopApi.enableOfficialCatalog).not.toHaveBeenCalled();
  await confirm();
  await expect.element(refreshButton()).toBeEnabled();
  expect(desktopApi.enableOfficialCatalog).toHaveBeenCalledExactlyOnceWith("a".repeat(64), 7);
  expect(desktopApi.refreshOfficialCatalog).toHaveBeenCalledExactlyOnceWith(
    7,
    expect.any(Function),
  );
  expect(changed).toHaveBeenCalledOnce();
  await expect.element(page.getByText("Official catalog refreshed.")).toBeVisible();
  await expect.poll(() => document.activeElement?.textContent).toBe("Refresh official catalog");
});

it("refuses duplicate same-turn confirmation while the original enablement is pending", async () => {
  const pending = deferred<OfficialCatalogSetup>();
  vi.mocked(desktopApi.enableOfficialCatalog).mockReturnValue(pending.promise);
  await render();
  await click(enableButton());
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Enable updates",
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(desktopApi.enableOfficialCatalog).toHaveBeenCalledOnce();
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await act(async () => pending.resolve({ changed: true, review: enabled }));
  await expect.element(refreshButton()).toBeEnabled();
  expect(desktopApi.refreshOfficialCatalog).toHaveBeenCalledOnce();
});

it("reads back lost enablement responses without replaying setup", async () => {
  vi.mocked(desktopApi.officialCatalogReview)
    .mockResolvedValueOnce(configured)
    .mockResolvedValue(enabled);
  vi.mocked(desktopApi.enableOfficialCatalog).mockRejectedValue(
    new Error("Enablement response lost"),
  );
  await render();
  await confirm();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Enablement response lost");
  await expect.element(refreshButton()).toBeEnabled();
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
  await click(refreshButton());
  await expect.element(page.getByText("Official catalog refreshed.")).toBeVisible();
  expect(desktopApi.enableOfficialCatalog).toHaveBeenCalledOnce();
  expect(desktopApi.refreshOfficialCatalog).toHaveBeenCalledOnce();
});

it("requires a fresh confirmation after a stale source or library review", async () => {
  const fresh = { ...configured, expected_plan: "f".repeat(64) };
  vi.mocked(desktopApi.officialCatalogReview)
    .mockResolvedValueOnce(configured)
    .mockResolvedValue(fresh);
  vi.mocked(desktopApi.enableOfficialCatalog).mockRejectedValueOnce(
    new Error("Official catalog setup review is stale"),
  );
  await render();
  await confirm();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Official catalog setup review is stale");
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
  expect(desktopApi.enableOfficialCatalog).toHaveBeenCalledOnce();
  await confirm();
  await expect.element(refreshButton()).toBeEnabled();
  expect(desktopApi.enableOfficialCatalog).toHaveBeenLastCalledWith("f".repeat(64), 7);
});

it("cancels the owned refresh and preserves enabled setup for a later retry", async () => {
  const pending = deferred<ListingDeliveryStatus>();
  vi.mocked(desktopApi.officialCatalogReview)
    .mockResolvedValueOnce(configured)
    .mockResolvedValue(enabled);
  vi.mocked(desktopApi.refreshOfficialCatalog).mockImplementation((_generation, report) => {
    report(started);
    return pending.promise;
  });
  await render();
  await confirm();
  await expect.element(page.getByRole("button", { name: "Cancel catalog refresh" })).toBeEnabled();
  await click(page.getByRole("button", { name: "Cancel catalog refresh" }));
  expect(desktopApi.cancelOperation).toHaveBeenCalledExactlyOnceWith("owned-catalog-refresh");
  await act(async () => pending.reject({ code: "cancelled" }));
  await expect.element(page.getByText("Catalog refresh cancelled.")).toBeVisible();
  await expect.element(refreshButton()).toBeEnabled();
  expect(desktopApi.enableOfficialCatalog).toHaveBeenCalledOnce();
});

it("does not continue an outgoing library after its delayed enablement response", async () => {
  const pending = deferred<OfficialCatalogSetup>();
  vi.mocked(desktopApi.enableOfficialCatalog).mockReturnValue(pending.promise);
  vi.mocked(desktopApi.officialCatalogReview).mockImplementation(async (generation) =>
    generation === 7 ? configured : unavailable,
  );
  await render();
  await confirm();
  await render(8);
  await act(async () => pending.resolve({ changed: true, review: enabled }));
  await expect
    .element(page.getByText("Official catalog updates are unavailable in this release."))
    .toBeVisible();
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Official catalog refreshed.");
});

it("drops old refresh events and readback after a library generation change", async () => {
  const pending = deferred<ListingDeliveryStatus>();
  let report!: (event: OperationEvent) => void;
  vi.mocked(desktopApi.officialCatalogReview).mockImplementation(async (generation) =>
    generation === 7 ? enabled : unavailable,
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
  await expect.element(enableButton()).toBeDisabled();
  expect(desktopApi.enableOfficialCatalog).not.toHaveBeenCalled();
  expect(desktopApi.refreshOfficialCatalog).not.toHaveBeenCalled();
});
