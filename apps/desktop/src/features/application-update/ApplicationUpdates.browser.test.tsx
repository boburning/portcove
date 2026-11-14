import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { failureReport } from "../../test-fixtures";
import type { ApplicationUpdateProgress, ApplicationUpdateStatus } from "../../types";
import { initializeLocalization } from "../../localization";
import { ApplicationUpdateSettings } from "./ApplicationUpdates";
import { useApplicationUpdate } from "./use-application-update";

vi.mock("../../desktop-events", () => ({ listenDesktopEvent: async () => () => undefined }));

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
  vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue(available);
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
  await expect.element(page.getByText("Faster library loading.")).toBeVisible();
  await page.getByRole("button", { name: "Download and restart", exact: true }).click();
  expect(install).toHaveBeenCalledExactlyOnceWith("0.2.0", 7, expect.any(Function));
  await expect.element(page.getByText("Starting the download…")).toBeVisible();
  report?.({ phase: "downloading", downloaded_bytes: 1024 * 1024, total_bytes: 4 * 1024 * 1024 });
  await expect.element(page.getByText("Downloading 1.0 MiB of 4.0 MiB…")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeDisabled();
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
});
