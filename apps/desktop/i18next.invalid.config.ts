import { defineConfig } from "i18next-cli";
import configuration from "./i18next.config.ts";

const outputRoot = process.env.PORTCOVE_I18N_NEGATIVE_ROOT;
if (!outputRoot) throw new Error("PORTCOVE_I18N_NEGATIVE_ROOT is required");
const placeholdersOnly = process.env.PORTCOVE_I18N_PLACEHOLDER_ONLY === "1";

export default defineConfig({
  locales: ["en", "ar-XB"],
  extract: {
    input: placeholdersOnly
      ? configuration.extract.input
      : ["test/fixtures/i18n-invalid/InvalidLocalization.tsx"],
    output: `${outputRoot}/{{language}}/{{namespace}}.json`,
    defaultNS: "settings",
    primaryLanguage: "en",
    secondaryLanguages: ["ar-XB"],
    removeUnusedKeys: false,
  },
  lint: {
    ...(placeholdersOnly ? configuration.lint : {}),
    checkInterpolationParams: true,
    checkTranslationPlaceholders: "error",
  },
});
