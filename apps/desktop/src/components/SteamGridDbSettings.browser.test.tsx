import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import {
  listingSummary,
  resetSteamGridDbCheckForTests,
  SteamGridDbSettings,
} from "./SteamGridDbSettings";
import type { SteamGridDbListingReport } from "../types";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  resetSteamGridDbCheckForTests();
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
  effect: "none",
  withdrawn_at: null,
  evicted_at: null,
});
const counts = { skipped: 0, removed: 0, removal_deferred: 0, removal_failed: 0 };

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
      ...counts,
    }),
  );
  const status = await vi.waitFor(() => {
    const element = [...container.querySelectorAll('[role="status"]')].find((item) =>
      item.textContent?.includes("4 SteamGridDB images:"),
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

it("keeps one check per library across a remount and forgets it when the library changes", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
  let finish: (report: SteamGridDbListingReport) => void = () => undefined;
  const check = vi.spyOn(desktopApi, "checkSteamGridDbListings").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={4} />);
  });
  await vi.waitFor(() => expect(buttonNamed("Check SteamGridDB images")).toBeDefined());
  await act(async () => buttonNamed("Check SteamGridDB images")!.click());
  // Leaving Settings and coming back still shows the running check.
  await act(async () => {
    await root.rerender(null);
  });
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={4} />);
  });
  await vi.waitFor(() => expect(buttonNamed("Checking SteamGridDB images…")?.disabled).toBe(true));
  expect(check).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      checked_at: 1,
      images: [{ ...checked({ status: "not_listed" }), effect: "removed" }],
      stopped: null,
      recorded: true,
      ...counts,
      removed: 1,
    }),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Portcove recorded what it found. Removed 1 copy of images SteamGridDB no longer lists.",
    ),
  );
  // Another library never shows this library's result.
  await act(async () => {
    await root.rerender(<SteamGridDbSettings generation={5} />);
  });
  expect(container.textContent).not.toContain("removed 1 copy");
  expect(buttonNamed("Check SteamGridDB images")?.disabled).toBe(false);
});

it("counts only finished removals and explains kept, listed-again and held copies", () => {
  const summary = listingSummary({
    checked_at: 1,
    images: [
      { ...checked({ status: "not_listed" }), effect: "removed" },
      { ...checked({ status: "not_listed" }), effect: "withdrawn" },
      { ...checked({ status: "listed" }), effect: "listed_again" },
    ],
    stopped: null,
    recorded: true,
    skipped: 1,
    removed: 2,
    removal_deferred: 3,
    removal_failed: 1,
  });
  expect(summary).toContain(
    "1 image is confirmed removed from SteamGridDB. Portcove kept its copy, because you imported it yourself or another credit still lists it.",
  );
  expect(summary).toContain(
    "1 image is listed again. If Portcove removed its copy, choose it again to restore it.",
  );
  expect(summary).toContain(
    "Portcove recorded what it found. Removed 2 copies of images SteamGridDB no longer lists. Your choices and credits were kept, and nothing changed in Steam.",
  );
  // A removal that has not finished never reads as nothing removed.
  const pending = listingSummary({
    checked_at: 1,
    images: [{ ...checked({ status: "not_listed" }), effect: "removed" }],
    stopped: null,
    recorded: true,
    ...counts,
    removal_failed: 1,
  });
  expect(pending).toContain(
    "Portcove recorded what it found. No copy was deleted yet. Your choices and credits were kept, and nothing changed in Steam.",
  );
  expect(pending.join(" ")).not.toContain("Nothing was removed");
  // Removed or removing copies point to the game's Steam shortcut review.
  const pointer =
    "If Portcove added any of these images to Steam, choose the game's Steam shortcut button, then Review artwork update or Review artwork removal.";
  expect(pending).toContain(pointer);
  expect(summary).toContain(pointer);
  expect(
    listingSummary({
      checked_at: 1,
      images: [checked({ status: "listed" })],
      stopped: null,
      recorded: true,
      ...counts,
    }),
  ).not.toContain(pointer);
  expect(summary).toContain("3 more copies will be removed by the next check, export or move.");
  expect(summary).toContain(
    "Portcove couldn't remove 1 copy. It is no longer shown or used. Close any program that may be using Portcove's artwork folder, then check again.",
  );
  expect(summary).toContain("1 result could not be recorded and will be checked first next time.");
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
  expect(
    listingSummary({ checked_at: 1, images: [], stopped: null, recorded: true, ...counts }),
  ).toEqual(["Your library has no SteamGridDB images to check. Nothing was changed."]);
  const unrecorded = listingSummary({
    checked_at: 1,
    images: [checked({ status: "listed" })],
    stopped: { reason: "rate_limited", retry_after_seconds: 90 },
    recorded: false,
    ...counts,
  });
  expect(unrecorded[0]).toBe(
    "1 SteamGridDB image: 1 still listed, 0 not in SteamGridDB's list when checked, 0 not confirmed.",
  );
  expect(unrecorded).toContain(
    "SteamGridDB asked Portcove to slow down. Check again in 2 minutes.",
  );
  expect(unrecorded.at(-1)).toBe(
    "These results were not recorded. Nothing was removed; check again to record them.",
  );
  const unreached = listingSummary({
    checked_at: 1,
    images: [checked({ status: "unknown", reason: "check_stopped" }, false)],
    stopped: { reason: "cancelled" },
    recorded: false,
    ...counts,
  });
  expect(unreached.at(-1)).toBe("Nothing was checked this time. Nothing was removed.");
  expect(unreached).toContain(
    "The check stopped because the library changed. Check again when you are ready.",
  );
  const rejected = listingSummary({
    checked_at: 1,
    images: [checked({ status: "listed" })],
    stopped: { reason: "key_rejected" },
    recorded: true,
    ...counts,
  });
  expect(rejected).toContain(
    "SteamGridDB rejected your saved key. Replace it above, then check again.",
  );
});
