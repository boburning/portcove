import { captureParityState } from "../../../test/parity-capture";
import { page } from "vite-plus/test/browser";
import { act } from "react";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { listenDesktopEvent } from "../../desktop-events";
import { failureReport } from "../../test-fixtures";
import type { ApplicationUpdateProgress, ApplicationUpdateStatus } from "../../types";
import { initializeLocalization } from "../../localization";
import { ApplicationUpdateSettings } from "./ApplicationUpdates";
import { useApplicationUpdate } from "./use-application-update";

vi.mock("../../desktop-events", () => ({ listenDesktopEvent: vi.fn(async () => () => undefined) }));

const available: ApplicationUpdateStatus = {
  current_version: "0.1.0",
  checking: false,
  installing: false,
  available: {
    version: "0.2.0",
    channel: "beta",
    notes: "Faster library loading.",
    date: "2026-11-01T12:00:00Z",
  },
  last_checked_unix_seconds: 1_793_000_000,
};

function Fixture() {
  return (
    <ApplicationUpdateSettings
      update={useApplicationUpdate()}
      currentVersion="0.1.0"
      generation={7}
    />
  );
}

beforeAll(() => {
  initializeLocalization();
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});

it("saves the channel and automatic checks immediately", async () => {
  vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue({
    ...available,
    available: null,
  });
  vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
    channel: "beta",
    automatic_checks: true,
  });
  const save = vi
    .spyOn(desktopApi, "setApplicationUpdatePreferences")
    .mockImplementation(async (preferences) => preferences);
  await render(<Fixture />);
  await expect.element(page.getByText(/Portcove is up to date/u)).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  expect(save).toHaveBeenLastCalledWith({ channel: "preview", automatic_checks: true });
  await expect
    .element(page.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByText(/Preview gets new versions first/u)).toBeVisible();
  await page.getByRole("checkbox", { name: /Check for updates automatically/u }).click();
  expect(save).toHaveBeenLastCalledWith({ channel: "preview", automatic_checks: false });
});

it("installs the reviewed version with progress and shows a busy-library refusal", async () => {
  await page.viewport(430, 780);
  document.documentElement.dataset.theme = "light";
  const longNotes = Array.from({ length: 20 }, (_, index) => `Release change ${index + 1}.`).join(
    "\n",
  );
  vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue({
    ...available,
    available: { ...available.available!, notes: longNotes },
  });
  vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
    channel: "beta",
    automatic_checks: true,
  });
  let report: ((event: ApplicationUpdateProgress) => void) | undefined;
  let refuse: ((error: unknown) => void) | undefined;
  const install = vi
    .spyOn(desktopApi, "installApplicationUpdate")
    .mockImplementation((_version, _generation, onEvent) => {
      report = onEvent;
      return new Promise((_resolve, reject) => {
        refuse = reject;
      });
    });
  await render(<Fixture />);
  await expect
    .element(page.getByRole("heading", { name: "Portcove 0.2.0 is available" }))
    .toBeVisible();
  const notes = page.getByText(/Release change 20/u);
  await expect.element(notes).toBeVisible();
  const download = page.getByRole("button", { name: "Download and restart", exact: true });
  expect(
    download.element().compareDocumentPosition(notes.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await download.click();
  expect(install).toHaveBeenCalledExactlyOnceWith("0.2.0", 7, expect.any(Function));
  await expect.element(page.getByText("Starting the download…")).toBeVisible();
  await expect.element(page.getByText("Updating Portcove…", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Portcove 0.2.0 is ready to download.", { exact: true }))
    .not.toBeInTheDocument();
  report?.({ phase: "downloading", downloaded_bytes: 1024 * 1024, total_bytes: 4 * 1024 * 1024 });
  await expect.element(page.getByText("Downloading 1.0 MiB of 4.0 MiB…")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeDisabled();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  await expect.element(page.getByText("Updating Portcove…", { exact: true })).toBeVisible();
  await captureParityState("application-update-controlled-progress");
  refuse?.({
    ...failureReport(),
    code: "conflict",
    details: { application_update_refusal: "library-busy" },
  });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Portcove is still working on your library, so the update wasn’t installed. Wait for installs, backups and running games to finish, then try again.",
    );
  await expect
    .element(page.getByRole("button", { name: "Download and restart", exact: true }))
    .toBeEnabled();
  await expect
    .element(page.getByText("Portcove 0.2.0 is ready to download.", { exact: true }))
    .toBeVisible();
  const alert = page.getByRole("alert").element();
  expect(download.element().closest("article")).toBe(alert.closest("article"));
  expect(
    alert.compareDocumentPosition(download.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const alertBounds = alert.getBoundingClientRect();
  expect(alertBounds.top).toBeGreaterThanOrEqual(0);
  expect(alertBounds.bottom).toBeLessThanOrEqual(innerHeight);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  await captureParityState("application-update-settled-refusal");
});

it("keeps a refusal from an older offer outside a replacement offer", async () => {
  vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue(available);
  vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
    channel: "beta",
    automatic_checks: true,
  });
  let refuse: ((reason: unknown) => void) | undefined;
  const install = vi.spyOn(desktopApi, "installApplicationUpdate").mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await render(<Fixture />);
  const download = page.getByRole("button", { name: "Download and restart", exact: true });
  await download.click();
  const subscription = vi.mocked(listenDesktopEvent).mock.lastCall;
  expect(subscription?.[0]).toBe("portcove://application-update-notice");
  await act(async () => {
    subscription?.[1]({ ...available, available: { ...available.available!, version: "0.3.0" } });
    refuse?.({ ...failureReport(), details: { application_update_refusal: "stale" } });
  });
  await expect
    .element(page.getByRole("heading", { name: "Portcove 0.3.0 is available" }))
    .toBeVisible();
  const alert = page.getByRole("alert");
  await expect.element(alert).toBeVisible();
  expect(download.element().closest("article")?.contains(alert.element())).toBe(false);
  await expect.element(download).toBeEnabled();
  expect(install).toHaveBeenCalledExactlyOnceWith("0.2.0", 7, expect.any(Function));
});

it("shows a host-reported update as active without inventing local download progress", async () => {
  await page.viewport(960, 800);
  document.documentElement.dataset.theme = "dark";
  vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue({
    ...available,
    installing: true,
  });
  vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
    channel: "beta",
    automatic_checks: true,
  });
  const install = vi.spyOn(desktopApi, "installApplicationUpdate");
  await render(<Fixture />);
  await expect.element(page.getByText("Updating Portcove…", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Portcove 0.2.0 is ready to download.", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Starting the download…", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Download and restart", exact: true }))
    .toBeDisabled();
  expect(install).not.toHaveBeenCalled();
  await captureParityState("application-update-host-active");
});

it("does not blame the connection when the update server returns no update information", async () => {
  vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue({
    ...available,
    available: null,
  });
  vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
    channel: "beta",
    automatic_checks: true,
  });
  vi.spyOn(desktopApi, "checkApplicationUpdate").mockRejectedValue({
    ...failureReport(),
    code: "network",
    details: { application_update_refusal: "release-not-found" },
  });
  await render(<Fixture />);
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Portcove couldn’t get update information. Try again later.");
  await expect.element(page.getByText(/internet connection/u)).not.toBeInTheDocument();
});
