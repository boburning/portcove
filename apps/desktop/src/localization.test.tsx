// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageSettings } from "./components/LanguageSettings";
import {
  assertCatalog,
  initializeLocalization,
  LocalizationProvider,
  localeDirection,
  localeOptions,
  resolveLocale,
  useLocalization,
  type LocalePreferenceApi,
} from "./localization";

describe("localization foundation", () => {
  it("resolves only approved exact or English-family locales", () => {
    expect(resolveLocale("ar-XB", ["en-US"])).toBe("ar-XB");
    expect(resolveLocale("en-GB", ["ar-XB"])).toBe("en");
    expect(resolveLocale(null, ["fr-FR", "en-US"])).toBe("en");
    expect(resolveLocale(null, ["ar-EG"])).toBe("en");
    expect(resolveLocale(null, ["ar-XB"])).toBe("en");
    expect(resolveLocale("not_a_locale", ["ar-XB"])).toBe("en");
    expect(localeDirection("ar-XB")).toBe("rtl");
    expect(localeOptions.map(({ value }) => value)).toEqual(["system", "en"]);
  });

  it("rejects malformed and empty offline catalogs and never exposes a raw missing key", () => {
    expect(() => assertCatalog({ language: { title: "" } })).toThrow(/Empty localization/);
    expect(() => assertCatalog({ language: null })).toThrow(/Invalid localization/);
    const instance = initializeLocalization(["en-US"]);
    expect(instance.t("language.sample", { count: 2 })).toBe("2 localized messages are ready.");
    const runtimeTranslate = instance.t as unknown as (key: string) => string;
    expect(runtimeTranslate("unknown.key")).toBe("Translation unavailable");
  });
});

describe("LocalizationProvider", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.documentElement.lang = "";
    document.documentElement.dir = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists a live RTL change without remounting or losing focus", async () => {
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: null }),
      setLocalePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
    };
    let localization!: ReturnType<typeof useLocalization>;
    let mounts = 0;
    function Fixture() {
      localization = useLocalization();
      const [value, setValue] = useState("retained");
      useState(() => {
        mounts += 1;
      });
      return <input value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <Fixture />
        </LocalizationProvider>,
      ),
    );
    const input = host.querySelector("input")!;
    input.focus();
    await act(async () => localization.select("ar-XB"));
    expect(api.setLocalePreference).toHaveBeenCalledWith("ar-XB");
    expect(host.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(mounts).toBe(1);
    expect(document.documentElement.lang).toBe("ar-XB");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("keeps the previous locale and never reports success when persistence fails", async () => {
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: "en" }),
      setLocalePreference: vi.fn().mockRejectedValue(new Error("write denied")),
    };
    let localization!: ReturnType<typeof useLocalization>;
    function Fixture() {
      localization = useLocalization();
      return <span>{localization.locale}</span>;
    }
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <Fixture />
        </LocalizationProvider>,
      ),
    );
    await act(async () => localization.select("ar-XB"));
    expect(localization.locale).toBe("en");
    expect(localization.error).toBe("save");
    expect(localization.saved).toBe(false);
  });

  it("ignores a stale startup preference after a newer selection succeeds", async () => {
    let resolveRead!: (snapshot: { locale: string | null }) => void;
    const pendingRead = new Promise<{ locale: string | null }>((resolve) => {
      resolveRead = resolve;
    });
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockReturnValue(pendingRead),
      setLocalePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
    };
    let localization!: ReturnType<typeof useLocalization>;
    function Fixture() {
      localization = useLocalization();
      return <span>{localization.locale}</span>;
    }
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <Fixture />
        </LocalizationProvider>,
      ),
    );
    await act(async () => localization.select("ar-XB"));
    await act(async () => {
      resolveRead({ locale: null });
      await pendingRead;
    });
    expect(localization.locale).toBe("ar-XB");
    expect(localization.saved).toBe(true);
    expect(localization.error).toBeNull();
  });

  it("ignores a stale startup failure after a newer selection succeeds", async () => {
    let rejectRead!: (error: Error) => void;
    const pendingRead = new Promise<{ locale: string | null }>((_resolve, reject) => {
      rejectRead = reject;
    });
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockReturnValue(pendingRead),
      setLocalePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
    };
    let localization!: ReturnType<typeof useLocalization>;
    function Fixture() {
      localization = useLocalization();
      return <span>{localization.locale}</span>;
    }
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <Fixture />
        </LocalizationProvider>,
      ),
    );
    await act(async () => localization.select("ar-XB"));
    await act(async () => {
      rejectRead(new Error("stale read failure"));
      await pendingRead.catch(() => undefined);
    });
    expect(localization.locale).toBe("ar-XB");
    expect(localization.saved).toBe(true);
    expect(localization.error).toBeNull();
  });

  it("names the resolved English fallback for an unsupported system language", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: null }),
      setLocalePreference: vi.fn(),
    };
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <LanguageSettings />
        </LocalizationProvider>,
      ),
    );
    expect(host.textContent).toContain("Current language: English.");
    expect(host.textContent).not.toContain("localized messages are ready");
    expect(host.textContent).not.toContain("Keyboard focus stays");
    expect(host.textContent).not.toContain("العربية");
  });

  it("distinguishes a failed preference load from a failed save without changing the display", async () => {
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockRejectedValue(new Error("read denied")),
      setLocalePreference: vi.fn().mockRejectedValue(new Error("write denied")),
    };
    let localization!: ReturnType<typeof useLocalization>;
    function Fixture() {
      localization = useLocalization();
      return <LanguageSettings />;
    }
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <Fixture />
        </LocalizationProvider>,
      ),
    );
    expect(localization.error).toBe("load");
    expect(host.textContent).toContain(
      "Couldn't load your language preference. Using English for now.",
    );
    await act(async () => localization.select("ar-XB"));
    expect(localization.error).toBe("save");
    expect(localization.locale).toBe("en");
    expect(host.textContent).toContain(
      "Couldn't save the language. Your current language is unchanged.",
    );
  });

  it("does not describe a post-save display failure as a rejected preference write", async () => {
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: "en" }),
      setLocalePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
    };
    let localization!: ReturnType<typeof useLocalization>;
    function Fixture() {
      localization = useLocalization();
      return <LanguageSettings />;
    }
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <Fixture />
        </LocalizationProvider>,
      ),
    );
    vi.spyOn(initializeLocalization(), "changeLanguage").mockRejectedValueOnce(
      new Error("display switch failed"),
    );
    await act(async () => localization.select("ar-XB"));
    expect(localization.error).toBe("apply");
    expect(localization.saved).toBe(false);
    expect(host.textContent).toContain("Language preference saved, but Portcove couldn't confirm");
    expect(host.textContent).not.toContain("Couldn't save the language.");
  });

  it("labels a previously saved engineering locale as a limited preview", async () => {
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
      setLocalePreference: vi.fn(),
    };
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <LanguageSettings />
        </LocalizationProvider>,
      ),
    );
    expect(document.documentElement.lang).toBe("ar-XB");
    expect(document.documentElement.dir).toBe("rtl");
    expect(host.textContent).toContain("معاينة اللغة");
    expect(host.textContent).toContain("باقي Portcove باللغة الإنجليزية");
    expect(host.textContent).not.toContain("رسائل مترجمة جاهزة");
  });

  it("returns focus to the language picker after an asynchronous saved change", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolveWrite!: (snapshot: { locale: string }) => void;
    const write = new Promise<{ locale: string }>((resolve) => {
      resolveWrite = resolve;
    });
    const api: LocalePreferenceApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: "ar-XB" }),
      setLocalePreference: vi.fn().mockReturnValue(write),
    };
    await act(async () =>
      root.render(
        <LocalizationProvider api={api}>
          <LanguageSettings />
        </LocalizationProvider>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!;
    await act(async () => trigger.click());
    const english = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === "English",
    );
    await act(async () => english?.click());
    expect(trigger.disabled).toBe(true);
    await act(async () => resolveWrite({ locale: "en" }));
    expect(trigger.disabled).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
