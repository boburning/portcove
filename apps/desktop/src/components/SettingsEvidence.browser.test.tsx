import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { captureParityState } from "../../test/parity-capture";
import { SettingsView } from "./Chrome";
import type { GithubAuthStatus } from "../types";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { LanguageSettings } from "./LanguageSettings";

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
  initializeLocalization(["en"]);
  await page.viewport(1280, 800);
});

const connectionCases: Array<{ name: string; status?: GithubAuthStatus; label: string }> = [
  { name: "unavailable", label: "Connection status unavailable" },
  {
    name: "anonymous",
    status: {
      source: "anonymous",
      authenticated: false,
      login: null,
      rate_limit: null,
      device_login_available: true,
    },
    label: "Not signed in",
  },
  {
    name: "connected",
    status: {
      source: "credential_store",
      authenticated: true,
      login: "fixture-player",
      rate_limit: { limit: 5000, remaining: 4998, resets_at: 1 },
      device_login_available: true,
    },
    label: "Connected as fixture-player",
  },
  {
    name: "rate-limit",
    status: {
      source: "anonymous",
      authenticated: false,
      login: null,
      rate_limit: { limit: 60, remaining: 0, resets_at: 1 },
      device_login_available: false,
    },
    label: "Not signed in",
  },
];

it.each(connectionCases)(
  "renders the actual GitHub Settings $name state without credentials",
  async ({ name, status, label }) => {
    document.documentElement.dataset.theme = "dark";
    await page.viewport(1024, 800);
    const actions = {
      status,
      token: "",
      setToken: vi.fn(),
      saveToken: vi.fn(),
      logout: vi.fn(),
      beginDeviceLogin: vi.fn(),
      refresh: vi.fn(),
    };
    await render(<SettingsView github={actions} />);
    await page.getByRole("button", { name: "Integrations", exact: true }).click();
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
    await page.getByText("Connection details", { exact: true }).click();
    await expect.element(page.getByText("Sign-in source:", { exact: false })).toBeVisible();
    await captureParityState(`github-${name}-synthetic`);
    expect(actions.saveToken).not.toHaveBeenCalled();
    expect(actions.beginDeviceLogin).not.toHaveBeenCalled();
  },
);

it("renders a synthetic device code and password entry at narrow width", async () => {
  document.documentElement.dataset.theme = "light";
  await page.viewport(320, 844);
  await render(
    <SettingsView
      github={{
        status: {
          source: "anonymous",
          authenticated: false,
          login: null,
          rate_limit: null,
          device_login_available: true,
        },
        token: "",
        setToken: vi.fn(),
        saveToken: vi.fn(),
        logout: vi.fn(),
        beginDeviceLogin: vi.fn(),
        refresh: vi.fn(),
        deviceLogin: {
          expires_at: 10,
          interval_seconds: 5,
          session_id: "fixture-only",
          user_code: "DEMO-CODE",
          verification_uri: "https://github.example/device",
        },
      }}
    />,
  );
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect.element(page.getByText("Enter DEMO-CODE", { exact: true })).toBeVisible();
  await expect
    .element(page.getByLabelText("Personal access token"))
    .toHaveAttribute("type", "password");
  await captureParityState("github-device-code-narrow-synthetic");
});

it("retains the actual Advanced privacy explanation", async () => {
  document.documentElement.dataset.theme = "light";
  await page.viewport(740, 900);
  await render(<SettingsView />);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const privacy = page.getByRole("heading", {
    name: "Original game files stay local",
    exact: true,
  });
  privacy.element().scrollIntoView({ block: "center" });
  await expect.element(privacy).toBeVisible();
  await captureParityState("advanced-privacy-explanation");
});

it("renders a failed language-preference read in the actual language control", async () => {
  initializeLocalization(["en"]);
  await page.viewport(740, 900);
  await render(
    <LocalizationProvider
      api={{
        localePreference: vi.fn().mockRejectedValue(new Error("fixture read refusal")),
        setLocalePreference: vi.fn(),
      }}
    >
      <LanguageSettings />
    </LocalizationProvider>,
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Couldn't load your language preference. Using English for now.");
  await captureParityState("language-preference-load-failed-synthetic");
});

it("retains the current language after an actual picker save fails", async () => {
  initializeLocalization(["en"]);
  await page.viewport(740, 900);
  const save = vi.fn().mockRejectedValue(new Error("fixture save refusal"));
  await render(
    <LocalizationProvider
      api={{
        localePreference: vi.fn().mockResolvedValue({ locale: null }),
        setLocalePreference: save,
      }}
    >
      <LanguageSettings />
    </LocalizationProvider>,
  );
  await page.getByRole("combobox", { name: /^Display language\b/ }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Couldn't save the language. Your current language is unchanged.");
  expect(save).toHaveBeenCalledExactlyOnceWith("en");
  await captureParityState("language-preference-save-failed-synthetic");
});
