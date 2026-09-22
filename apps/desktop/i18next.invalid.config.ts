import { defineConfig } from "i18next-cli";

const outputRoot = process.env.PORTCOVE_I18N_NEGATIVE_ROOT;
if (!outputRoot) throw new Error("PORTCOVE_I18N_NEGATIVE_ROOT is required");

export default defineConfig({
  locales: ["en", "ar-XB"],
  extract: {
    input: ["test/fixtures/i18n-invalid/InvalidLocalization.tsx"],
    output: `${outputRoot}/{{language}}/{{namespace}}.json`,
    defaultNS: "settings",
    primaryLanguage: "en",
    secondaryLanguages: ["ar-XB"],
    removeUnusedKeys: false,
  },
  lint: {
    checkInterpolationParams: true,
  },
});
