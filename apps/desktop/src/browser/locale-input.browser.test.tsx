import { captureParityState } from "../../test/parity-capture";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { LanguageSettings } from "../components/LanguageSettings";
import { GameFileObservationSummary } from "../features/browsing/GameFileObservationSummary";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { browserFixture } from "../../test/browser-fixture";
import { auditAccessibility } from "../../test/accessibility";
import arabic from "../locales/ar-XB/settings.json";

let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({
    storage: true,
    attributes: ["data-theme", "lang", "dir"],
    viewport: true,
  });
  localStorage.clear();
  fixture.defer(() => {
    vi.restoreAllMocks();
  });
  const localization = initializeLocalization(),
    language = localization.language;
  fixture.defer(() => localization.changeLanguage(language).then(() => {}));
  fixture.defer(() => cleanup());
});
afterEach(async () => fixture.dispose());

it("uses the real non-English timezone for display while retaining the exact UTC history identity", async () => {
  expect(navigator.language).toBe("fr-FR");
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Pacific/Auckland");
  const observedAt = Date.parse("2024-10-27T01:30:00.000Z") / 1000;
  await render(
    <main>
      <h1>Recorded file check</h1>
      <GameFileObservationSummary
        observation={{
          lastAccepted: {
            observedAt,
            expiresAt: observedAt + 300,
            deadline: 12345,
            routes: [
              {
                port_id: "selected",
                route: "external_registration",
                platform: "linux-x86-64",
                channel: "beta",
              },
            ],
          },
          usable: false,
          expired: true,
          outcome: "accepted",
        }}
        catalog
        portId="selected"
      />
    </main>,
  );
  const time = document.querySelector("time")!;
  expect(time.dateTime).toBe("2024-10-27T01:30:00.000Z");
  expect(time.textContent).toBe("27/10/2024 14:30:00");
  expect(document.body.textContent).toContain("The previous file check expired.");
  expect(document.body.textContent).not.toContain("Game-file checks are ready to use");
});

it("keeps long RTL engineering labels operable in a narrow settings state", async (context) => {
  await page.viewport(320, 800);
  const api = {
    localePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
    setLocalePreference: vi.fn().mockResolvedValue({ locale: "en" }),
  };
  await render(
    <LocalizationProvider api={api}>
      <main style={{ padding: 16 }}>
        <header className="page-header mb-5">
          <h1>Language settings fixture</h1>
        </header>
        <section aria-labelledby="locale-appearance-heading">
          <h2 id="locale-appearance-heading">Appearance</h2>
          <LanguageSettings />
        </section>
      </main>
    </LocalizationProvider>,
  );
  await expect.poll(() => document.documentElement.dir).toBe("rtl");
  const picker = page.getByRole("combobox", { name: new RegExp(arabic.language.pickerLabel) });
  await expect.element(picker).toBeEnabled();
  expect(document.documentElement.lang).toBe("ar-XB");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth + 1,
  );
  const heading = page
    .getByRole("heading", { name: "Language settings fixture", exact: true })
    .element();
  expect(heading.getBoundingClientRect().bottom).toBeLessThan(
    document.querySelector(".language-card")!.getBoundingClientRect().top,
  );
  await auditAccessibility(
    document.querySelector("main")!,
    "language-settings/ar-XB/rtl/320",
    context,
  );
  await captureParityState("language-settings-ar-XB-rtl");
  await picker.click();
  await captureParityState("language-picker-ar-XB-rtl");
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect.poll(() => document.documentElement.dir).toBe("ltr");
  expect(api.setLocalePreference).toHaveBeenCalledWith("en");
  await expect.element(page.getByRole("combobox", { name: /^Display language/ })).toHaveFocus();
});

it.each([
  ["Win32", "{Control>}f{/Control}"],
  ["MacIntel", "{Meta>}f{/Meta}"],
] as const)(
  "dispatches the %s application search modifier under a non-English browser locale",
  async (platform, keys) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const transport = installInteractiveTransport("collection", (message) => {
      throw new Error(message);
    });
    fixture.defer(() => transport.dispose());
    fixture.defer(() => cleanup());
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
    );
    await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
    const first = document.querySelector<HTMLButtonElement>(".collection-identity")!;
    first.focus();
    await userEvent.keyboard(keys);
    const search = page.getByRole("textbox", { name: "Search your library", exact: true });
    await expect.element(search).toHaveFocus();
    await search.fill("Harbor");
    await userEvent.keyboard(keys);
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveValue("Harbor");
    expect(document.querySelector("main h1")?.textContent).toBe("Your library");
  },
);
