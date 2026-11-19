import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import type { GithubAuthStatus } from "../types";

const anonymous: GithubAuthStatus = {
  authenticated: false,
  device_login_available: true,
  login: null,
  rate_limit: { limit: 60, remaining: 12, resets_at: 1 },
  source: "anonymous",
};

const connected: GithubAuthStatus = {
  ...anonymous,
  authenticated: true,
  login: "fixture-player",
  rate_limit: { limit: 5000, remaining: 4980, resets_at: 1 },
  source: "credential_store",
};

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(async () => {
  localStorage.clear();
  await page.viewport(1366, 900);
});
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  vi.restoreAllMocks();
  localStorage.clear();
});

const button = (name: string) => page.getByRole("button", { name, exact: true });
const installedSelection = () =>
  Array.from(document.querySelectorAll('[data-detail-origin^="updates:installed:"]'), (row) => ({
    target: row.getAttribute("data-detail-origin"),
    version: row.querySelector(".update-versions")?.textContent,
  }));

async function reviewAnonymousAllowance() {
  transport = installInteractiveTransport("library", (message) => {
    throw Error(message);
  });
  let auth = anonymous;
  vi.spyOn(desktopApi, "githubAuthStatus").mockImplementation(async () => auth);
  vi.spyOn(desktopApi, "forecastInstalledUpdateChecks").mockResolvedValue({
    games: 2,
    counted_requests: 30,
    sign_in_relief_requests: 30,
  });
  const check = vi.spyOn(desktopApi, "checkInstalled").mockResolvedValue([]);
  const begin = vi.spyOn(desktopApi, "beginGithubDeviceLogin").mockResolvedValue({
    session_id: "fixture-sign-in",
    user_code: "TEST-CODE",
    verification_uri: "https://github.com/login/device",
    interval_seconds: 1,
    expires_at: 60,
  });
  const poll = vi.spyOn(desktopApi, "pollGithubDeviceLogin").mockImplementation(async () => {
    auth = connected;
    return { state: "complete", status: connected };
  });
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await button("Activity").click();
  await page.getByRole("tab", { name: "Game updates", exact: true }).click();
  const selection = installedSelection();
  expect(selection).toHaveLength(2);
  await button("Check installed ports for updates").click();
  await expect.element(page.getByText(/about 12 are left without signing in/)).toBeVisible();
  await button("Open GitHub connection").click();
  await expect
    .element(page.getByRole("heading", { name: "GitHub connection", exact: true }))
    .toHaveFocus();
  expect(check).not.toHaveBeenCalled();
  return { selection, check, begin, poll };
}

it.each([
  { choice: "Check for updates", keys: "{Enter}", expectedCalls: 1 },
  { choice: "Not now", keys: "{Tab}{Enter}", expectedCalls: 0 },
])(
  "returns with the current account and allowance before $choice",
  async ({ keys, expectedCalls }) => {
    const { selection, check, begin, poll } = await reviewAnonymousAllowance();
    await button("Sign in with GitHub").click();
    await expect.element(page.getByText("Enter TEST-CODE")).toBeVisible();
    await expect.element(page.getByText("Connected as fixture-player")).toBeVisible();
    expect(begin).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledExactlyOnceWith("fixture-sign-in");
    await page.getByText("Connection details", { exact: true }).click();
    await expect.element(page.getByText(/Operating-system credential store/)).toBeVisible();
    await expect
      .element(page.getByText("4,980 of 5,000 GitHub requests remaining.", { exact: true }))
      .toBeVisible();
    await button("Return to update check").click();

    const accept = button("Check for updates");
    await expect.element(accept).toHaveFocus();
    await expect.element(page.getByText(/Signed in to GitHub as fixture-player/)).toBeVisible();
    await expect.element(page.getByText(/4,980 of 5,000 GitHub requests remaining/)).toBeVisible();
    await expect.element(button("Open GitHub connection")).not.toBeInTheDocument();
    await expect.element(button("Check anyway")).not.toBeInTheDocument();
    await expect.element(button("Not now")).toBeVisible();
    expect(installedSelection()).toEqual(selection);
    expect(check).not.toHaveBeenCalled();
    await userEvent.keyboard(keys);
    await expect.element(button("Not now")).not.toBeInTheDocument();
    await expect.poll(() => check.mock.calls.length).toBe(expectedCalls);
  },
);

it("returns to the anonymous decision without signing in and dismisses without checking", async () => {
  const { selection, check, begin } = await reviewAnonymousAllowance();
  await expect.element(page.getByText("Not signed in", { exact: true })).toBeVisible();
  await button("Return to update check").click();
  await expect.element(button("Check anyway")).toHaveFocus();
  await expect.element(page.getByText(/about 12 are left without signing in/)).toBeVisible();
  expect(installedSelection()).toEqual(selection);
  expect(begin).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  await userEvent.keyboard("{Tab}{Enter}");
  await expect.element(button("Not now")).not.toBeInTheDocument();
  await expect.element(button("Check installed ports for updates")).toHaveFocus();
  expect(check).not.toHaveBeenCalled();
});

it("keeps an unsigned decision on ordinary navigation without carrying its return action to a new decision", async () => {
  const { selection, check, begin } = await reviewAnonymousAllowance();
  await button("Activity").click();
  await page.getByRole("tab", { name: "Game updates", exact: true }).click();
  await expect.element(button("Check anyway")).toBeVisible();
  expect(installedSelection()).toEqual(selection);
  await button("Not now").click();
  await button("Check installed ports for updates").click();
  await expect.element(button("Check anyway")).toBeVisible();
  await button("Settings").click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  await expect
    .element(page.getByRole("heading", { name: "GitHub connection", exact: true }))
    .toBeVisible();
  await expect.element(button("Return to update check")).not.toBeInTheDocument();
  expect(begin).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});
