import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { listingSummary, SteamGridDbSettings } from "./SteamGridDbSettings";
import type { SteamGridDbListingReport } from "../types";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

const buttonNamed = (name: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === name);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("saves the player's own key without ever showing it back, then removes it", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: false });
  const save = vi.spyOn(desktopApi, "setSteamGridDbKey").mockResolvedValue({ configured: true });
  const clear = vi
    .spyOn(desktopApi, "clearSteamGridDbKey")
    .mockResolvedValue({ configured: false });
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={3} />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain("No SteamGridDB API key"));
  const input = container.querySelector<HTMLInputElement>("#steamgriddb-api-key")!;
  expect(input.type).toBe("password");
  await type(input, "0123456789abcdef0123456789abcdef");
  await act(async () => buttonNamed("Save key")!.click());
  expect(save).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef");
  await vi.waitFor(() => expect(container.textContent).toContain("key is saved on this device"));
  expect(container.querySelector("#steamgriddb-api-key")).toBeNull();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Remove key"));
  expect(container.innerHTML).not.toContain("0123456789abcdef");
  await act(async () => buttonNamed("Remove key")!.click());
  expect(clear).toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Images you already chose stay in your library"),
  );
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("steamgriddb-api-key"));
});

it("states a secure-store problem without exposing input it could not save", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockRejectedValue({
    code: "state",
    message: "store",
    presentation: {
      presentation_key: "credential_store_unavailable",
      summary: "This device has no secure credential storage that Portcove can use.",
      tone: "error",
      mutation_state: "no_changes",
      phase: null,
      recovery_actions: ["view_technical_details"],
      technical_message: "could not read the SteamGridDB key: No default store",
      technical_context: {},
    },
  });
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={3} />);
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "no secure credential storage",
    ),
  );
});

const checked = (
  listing: SteamGridDbListingReport["images"][number]["listing"],
  attempted = true,
): SteamGridDbListingReport["images"][number] => ({
  asset_sha256: "a".repeat(64),
  attribution: {
    provider: "steamgriddb",
    asset_id: 3,
    game_id: 42,
    role: "portrait_cover",
    author_name: "Artist 3",
    author_steam64: null,
    source_url: "https://cdn2.steamgriddb.com/grid/3.png",
    fetched_at: 1789038047,
  },
  listing,
  attempted,
  listing_total: 4,
  source: "not_checked",
  not_listed_since: null,
});

it("checks the chosen images with the library generation and states that nothing was removed", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
  let finish: (report: SteamGridDbListingReport) => void = () => undefined;
  const check = vi.spyOn(desktopApi, "checkSteamGridDbListings").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={3} />);
  });
  await vi.waitFor(() => expect(buttonNamed("Check SteamGridDB images")).toBeDefined());
  await act(async () => buttonNamed("Check SteamGridDB images")!.click());
  expect(check).toHaveBeenCalledWith(3);
  // One check at a time from this control.
  expect(buttonNamed("Checking SteamGridDB images…")?.disabled).toBe(true);
  await act(async () =>
    finish({
      checked_at: 1,
      images: [
        checked({ status: "listed" }),
        checked({ status: "not_listed" }),
        checked({ status: "unknown", reason: "unavailable" }),
        checked({ status: "unknown", reason: "check_stopped" }, false),
      ],
      stopped: { reason: "time_limit" },
      recorded: true,
    }),
  );
  const status = await vi.waitFor(() => {
    const element = [...container.querySelectorAll('[role="status"]')].find((item) =>
      item.textContent?.includes("Checked 4 SteamGridDB images"),
    );
    expect(element).toBeDefined();
    return element!;
  });
  expect(status.textContent).toContain(
    "1 still listed, 1 not in SteamGridDB's list when checked, 1 not confirmed.",
  );
  expect(status.textContent).toContain("1 image was not reached this run.");
  expect(status.textContent).toContain("three-minute limit");
  expect(status.textContent).toContain("Portcove recorded what it found. Nothing was removed.");
});

it("offers the check only with a saved key", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: false });
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={3} />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain("No SteamGridDB API key"));
  expect(buttonNamed("Check SteamGridDB images")).toBeUndefined();
  expect(container.textContent).toContain("or when you choose Check SteamGridDB images");
});

it("summarizes empty, unrecorded and stopped checks for the player", () => {
  expect(listingSummary({ checked_at: 1, images: [], stopped: null, recorded: true })).toEqual([
    "Your library has no SteamGridDB images to check. Nothing was changed.",
  ]);
  const unrecorded = listingSummary({
    checked_at: 1,
    images: [checked({ status: "listed" })],
    stopped: { reason: "rate_limited", retry_after_seconds: 90 },
    recorded: false,
  });
  expect(unrecorded[0]).toBe(
    "Checked 1 SteamGridDB image: 1 still listed, 0 not in SteamGridDB's list when checked, 0 not confirmed.",
  );
  expect(unrecorded).toContain(
    "SteamGridDB asked Portcove to slow down. Check again in 2 minutes.",
  );
  expect(unrecorded.at(-1)).toBe(
    "These results were not recorded. Nothing was removed; check again to record them.",
  );
  const rejected = listingSummary({
    checked_at: 1,
    images: [checked({ status: "listed" })],
    stopped: { reason: "key_rejected" },
    recorded: true,
  });
  expect(rejected).toContain(
    "SteamGridDB rejected your saved key. Replace it above, then check again.",
  );
});
