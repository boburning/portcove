import { describe, expect, it } from "vite-plus/test";
import {
  assertCatalog,
  initializeLocalization,
  localeDirection,
  localeOptions,
  resolveLocale,
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
    for (const key of [
      "unknown.key",
      "language.constructor",
      "language.toString",
      "language.__proto__.constructor",
    ]) {
      expect(runtimeTranslate(key)).toBe("Translation unavailable");
    }
  });

  it("formats migrated shell and update copy per locale without raw keys or inserted channel names", async () => {
    const instance = initializeLocalization(["en-US"]);
    try {
      await instance.changeLanguage("en");
      expect(instance.t("interfaceSize.applied", { ns: "shell", ratio: 1.25 })).toBe(
        "Interface size 125%.",
      );
      expect(instance.t("interfaceSize.unconfirmed", { ns: "shell", ratio: 1 })).toBe(
        "Interface size could not be confirmed. Try again or reset to 100%.",
      );
      expect(instance.t("notice.title", { ns: "applicationUpdate", version: "0.2.0" })).toBe(
        "Portcove 0.2.0 is available",
      );
      expect(
        instance.t("channel.description", { ns: "applicationUpdate", context: "preview" }),
      ).toBe("Preview gets new versions first, before Beta. Expect more problems.");

      await instance.changeLanguage("ar-XB");
      const percent = new Intl.NumberFormat("ar-XB", { style: "percent" }).format(1.25);
      expect(instance.t("interfaceSize.applied", { ns: "shell", ratio: 1.25 })).toBe(
        `حجم الواجهة ${percent}.`,
      );
      expect(instance.t("renderRecovery.title", { ns: "shell" })).toBe(
        "تعذر على Portcove عرض هذه الشاشة",
      );
      expect(instance.t("notice.title", { ns: "applicationUpdate", version: "1.0.1" })).toContain(
        "1.0.1",
      );
      // The counts namespace has no engineering resource and falls back to complete English.
      expect(instance.t("progressCount", { ns: "counts", completed: 1, total: 2 })).toMatch(/of/);
    } finally {
      await instance.changeLanguage("en");
    }
  });

  it("bundles the unreviewed Spanish draft without ever selecting it", async () => {
    expect(resolveLocale(null, ["es-ES", "es"])).toBe("en");
    expect(resolveLocale("es", ["es-MX"])).toBe("en");
    expect(localeOptions.map(({ value }) => value)).not.toContain("es");
    const instance = initializeLocalization(["en-US"]);
    try {
      await instance.changeLanguage("es");
      expect(instance.t("renderRecovery.title", { ns: "shell" })).toBe(
        "Portcove no pudo mostrar esta pantalla",
      );
      expect(instance.t("updates", { ns: "counts", count: 1 })).toBe("1 actualización disponible");
      expect(instance.t("updates", { ns: "counts", count: 3 })).toBe(
        "3 actualizaciones disponibles",
      );
    } finally {
      await instance.changeLanguage("en");
    }
  });
});
