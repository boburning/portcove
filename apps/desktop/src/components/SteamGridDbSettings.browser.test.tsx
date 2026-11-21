import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { StrictMode } from "react";
import { captureParityState } from "../../test/parity-capture";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import {
  listingSummary,
  resetSteamGridDbCheckForTests,
  SteamGridDbSettings,
} from "./SteamGridDbSettings";
import type { SteamGridDbKeyStatus, SteamGridDbListingReport } from "../types";
import "../styles/index.css";

let root: RenderResult;
let container: HTMLDivElement;
let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(async () => {
  initializeLocalization(["en"]);
  resetSteamGridDbCheckForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  container.remove();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const buttonNamed = (name: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === name);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function settingsRow() {
  const row = [...container.querySelectorAll<HTMLElement>('[data-slot="settings-row"]')].find(
    (item) => item.querySelector("h2")?.textContent === "SteamGridDB artwork",
  );
  if (!row) throw new Error("Expected the actual SteamGridDB Settings row");
  return row;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("settles a refused setup read, retries once and preserves key input after a save refusal", async () => {
  const first = deferred<SteamGridDbKeyStatus>();
  const retry = deferred<SteamGridDbKeyStatus>();
  const read = vi
    .spyOn(desktopApi, "steamGridDbKeyStatus")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise);
  const save = vi
    .spyOn(desktopApi, "setSteamGridDbKey")
    .mockRejectedValue(new Error("Controlled key save refused."));
  const clear = vi.spyOn(desktopApi, "clearSteamGridDbKey");
  await root.rerender(<SteamGridDbSettings generation={3} />);
  const row = settingsRow();
  await expect.element(page.elementLocator(row)).toHaveAttribute("aria-busy", "true");
  expect(row.textContent).toContain("Checking SteamGridDB setup…");
  expect(row.querySelector("input")).toBeNull();
  await act(async () => first.reject(new Error("Controlled setup status refused.")));
  await expect.element(page.elementLocator(row)).toHaveAttribute("aria-busy", "false");
  expect(row.textContent).not.toContain("Checking SteamGridDB setup…");
  expect(row.textContent).toContain("Couldn't check SteamGridDB setup.");
  expect(row.querySelector("input")).toBeNull();
  expect(buttonNamed("Remove key")).toBeUndefined();
  const recovery = buttonNamed("Check setup again")!;
  await expect.element(page.elementLocator(recovery)).toHaveAttribute("aria-busy", "false");
  recovery.focus();
  await act(async () => {
    recovery.click();
    recovery.click();
  });
  expect(read).toHaveBeenCalledTimes(2);
  await expect.element(page.elementLocator(row)).toHaveAttribute("aria-busy", "true");
  expect(row.querySelector('[role="status"]')?.textContent).toBe("Checking SteamGridDB setup…");
  expect(buttonNamed("Check setup again")).toBe(recovery);
  await expect.element(page.elementLocator(recovery)).toHaveTextContent("Check setup again");
  await expect.element(page.elementLocator(recovery)).toHaveAttribute("aria-busy", "true");
  await expect.element(page.elementLocator(recovery)).toHaveAttribute("aria-disabled", "true");
  await expect.element(page.elementLocator(recovery)).toHaveFocus();
  expect(row.querySelector("input")).toBeNull();
  await act(async () => retry.resolve({ configured: false }));
  await expect.element(page.elementLocator(row)).toHaveAttribute("aria-busy", "false");
  await expect.element(page.elementLocator(recovery)).toHaveAttribute("aria-busy", "false");
  await expect.element(page.elementLocator(recovery)).toHaveFocus();
  expect(row.querySelector('[role="alert"]')).toBeNull();
  const input = row.querySelector<HTMLInputElement>("#steamgriddb-api-key")!;
  expect(input.type).toBe("password");
  await type(input, "synthetic-test-key-not-a-credential");
  await act(async () => buttonNamed("Save key")!.click());
  await vi.waitFor(() =>
    expect(row.querySelector('[role="alert"]')?.textContent).toBe("Controlled key save refused."),
  );
  expect(input.value).toBe("synthetic-test-key-not-a-credential");
  expect(row.textContent).not.toContain("synthetic-test-key-not-a-credential");
  expect(save).toHaveBeenCalledExactlyOnceWith("synthetic-test-key-not-a-credential");
  expect(clear).not.toHaveBeenCalled();
});

it("keeps the current StrictMode status read after a retired read rejects", async () => {
  const retired = deferred<SteamGridDbKeyStatus>();
  const current = deferred<SteamGridDbKeyStatus>();
  const read = vi
    .spyOn(desktopApi, "steamGridDbKeyStatus")
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(current.promise);
  await root.rerender(
    <StrictMode>
      <SteamGridDbSettings generation={3} />
    </StrictMode>,
  );
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => current.resolve({ configured: true }));
  await expect.element(page.elementLocator(settingsRow())).toHaveAttribute("aria-busy", "false");
  await act(async () => retired.reject(new Error("Retired setup status refused.")));
  expect(settingsRow().textContent).not.toContain("Retired setup status refused.");
  expect(settingsRow().querySelector('[role="alert"]')).toBeNull();
  expect(buttonNamed("Remove key")?.disabled).toBe(false);
});

it("retains device key status across libraries while checking images in the current generation", async () => {
  const pending = deferred<SteamGridDbKeyStatus>();
  const read = vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockReturnValue(pending.promise);
  const check = vi.spyOn(desktopApi, "checkSteamGridDbListings").mockResolvedValue({
    checked_at: 1,
    images: [],
    stopped: null,
    recorded: true,
    skipped: 0,
    removed: 0,
    removal_deferred: 0,
    removal_failed: 0,
  });
  await root.rerender(<SteamGridDbSettings generation={3} />);
  await root.rerender(<SteamGridDbSettings generation={4} />);
  await act(async () => pending.resolve({ configured: true }));
  await act(async () => buttonNamed("Check SteamGridDB images")!.click());
  expect(read).toHaveBeenCalledExactlyOnceWith();
  expect(check).toHaveBeenCalledExactlyOnceWith(4);
});

it("ignores a read refusal after its Settings mount is replaced", async () => {
  const retired = deferred<SteamGridDbKeyStatus>();
  vi.spyOn(desktopApi, "steamGridDbKeyStatus")
    .mockReturnValueOnce(retired.promise)
    .mockResolvedValueOnce({ configured: false });
  await root.rerender(<SteamGridDbSettings generation={3} />);
  await root.rerender(null);
  await root.rerender(<SteamGridDbSettings generation={4} />);
  await vi.waitFor(() => expect(buttonNamed("Save key")).toBeDefined());
  await act(async () => retired.reject(new Error("Outgoing status refused.")));
  expect(settingsRow().querySelector('[role="alert"]')).toBeNull();
  await expect.element(page.elementLocator(settingsRow())).toHaveAttribute("aria-busy", "false");
});

it.each([
  ["dark", 960, 640],
  ["light", 430, 780],
] as const)(
  "recovers the actual %s App Integrations setup status at %i×%i",
  async (theme, width, height) => {
    await page.viewport(width, height);
    container.id = "root";
    transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    const first = deferred<SteamGridDbKeyStatus>();
    const retry = deferred<SteamGridDbKeyStatus>();
    const read = vi
      .spyOn(desktopApi, "steamGridDbKeyStatus")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    const save = vi.spyOn(desktopApi, "setSteamGridDbKey");
    const clear = vi.spyOn(desktopApi, "clearSteamGridDbKey");
    const diagnostic = `Controlled setup check refused: C:\\Synthetic\\${"x".repeat(200)}\\credential-store`;
    try {
      await root.rerender(
        <LocalizationProvider api={desktopApi}>
          <App />
        </LocalizationProvider>,
      );
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Settings categories", exact: true })
        .getByRole("button", { name: "Integrations", exact: true })
        .click();
      document.documentElement.dataset.theme = theme;
      const row = settingsRow();
      const scope = page.elementLocator(row);
      row.scrollIntoView({ block: "center", inline: "nearest" });
      await expect.element(scope).toHaveAttribute("aria-busy", "true");
      await expect
        .element(scope.getByRole("status"))
        .toHaveTextContent("Checking SteamGridDB setup…");
      expect(row.querySelector("input")).toBeNull();
      await captureParityState("steamgriddb-setup-reading");
      await act(async () => first.reject(new Error(diagnostic)));
      await expect.element(scope).toHaveAttribute("aria-busy", "false");
      await expect.element(scope.getByRole("alert")).toHaveTextContent(diagnostic);
      await expect
        .element(scope.getByRole("status"))
        .toHaveTextContent(
          "Couldn't check SteamGridDB setup. Check again to see whether a key is saved.",
        );
      const button = scope
        .getByRole("button", { name: "Check setup again", exact: true })
        .element();
      button.scrollIntoView({ block: "center", inline: "nearest" });
      const expectContainedRecovery = async () => {
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
        await expect.element(page.elementLocator(button)).toBeVisible();
        expect(button.isConnected).toBe(true);
        const bounds = button.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      };
      await expectContainedRecovery();
      await captureParityState("steamgriddb-setup-refused");
      await page.elementLocator(button).click();
      await expect.element(scope).toHaveAttribute("aria-busy", "true");
      await expect
        .element(scope.getByRole("status"))
        .toHaveTextContent("Checking SteamGridDB setup…");
      expect(scope.getByRole("button", { name: "Check setup again", exact: true }).element()).toBe(
        button,
      );
      await expect.element(page.elementLocator(button)).toHaveAttribute("aria-busy", "true");
      await expect.element(page.elementLocator(button)).toHaveAttribute("aria-disabled", "true");
      await expect.element(page.elementLocator(button)).toHaveFocus();
      expect(read).toHaveBeenCalledTimes(2);
      await expectContainedRecovery();
      expect(row.querySelector("input")).toBeNull();
      await captureParityState("steamgriddb-setup-retrying");
      await act(async () => retry.resolve({ configured: theme === "dark" }));
      await expect.element(scope).toHaveAttribute("aria-busy", "false");
      await expect.element(page.elementLocator(button)).toHaveAttribute("aria-busy", "false");
      await expect.element(page.elementLocator(button)).toHaveFocus();
      await expect.element(scope.getByRole("alert")).not.toBeInTheDocument();
      expect(
        scope
          .getByRole("button", { name: "Remove key", exact: true })
          .elements()
          .map((element) => (element as HTMLButtonElement).disabled),
      ).toEqual(theme === "dark" ? [false] : []);
      expect(
        scope
          .getByLabelText("SteamGridDB API key", { exact: true })
          .elements()
          .map((element) => element.getAttribute("type")),
      ).toEqual(theme === "dark" ? [] : ["password"]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(save).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      row.scrollIntoView({ block: "center", inline: "nearest" });
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await captureParityState("steamgriddb-setup-recovered");
    } finally {
      await act(async () => {
        first.resolve({ configured: false });
        retry.resolve({ configured: false });
      });
    }
  },
);

it("shows the configured image-check progress and mixed summary in actual App Settings", async () => {
  await page.viewport(960, 640);
  document.documentElement.dataset.theme = "dark";
  container.id = "root";
  transport = installInteractiveTransport("library", (message) => {
    throw new Error(message);
  });
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
  const imageCheck = deferred<SteamGridDbListingReport>();
  const check = vi
    .spyOn(desktopApi, "checkSteamGridDbListings")
    .mockReturnValue(imageCheck.promise);
  await root.rerender(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories", exact: true })
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  document.documentElement.dataset.theme = "dark";
  const row = settingsRow();
  const scope = page.elementLocator(row);
  await expect
    .element(scope.getByRole("button", { name: "Check SteamGridDB images", exact: true }))
    .toBeEnabled();
  await scope.getByRole("button", { name: "Check SteamGridDB images", exact: true }).click();
  await expect
    .element(scope.getByRole("button", { name: "Checking SteamGridDB images…", exact: true }))
    .toBeDisabled();
  row.scrollIntoView({ block: "center", inline: "nearest" });
  await captureParityState("steamgriddb-images-check-pending");
  await act(async () =>
    imageCheck.resolve({
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
  await expect.element(scope.getByText(/4 SteamGridDB images:/)).toBeVisible();
  expect(check).toHaveBeenCalledExactlyOnceWith(1);
  row.scrollIntoView({ block: "center", inline: "nearest" });
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  await captureParityState("steamgriddb-images-check-summary");
});

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
