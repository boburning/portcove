import { defineConfig } from "i18next-cli";
import configuration from "./i18next.config.ts";

const outputRoot = process.env.PORTCOVE_I18N_NEGATIVE_ROOT;
if (!outputRoot) throw new Error("PORTCOVE_I18N_NEGATIVE_ROOT is required");
const scope = process.env.PORTCOVE_I18N_NEGATIVE_SCOPE ?? "invalid";
if (!["invalid", "placeholders", "nested-missing", "nested-provided"].includes(scope))
  throw new Error("Known localization fixture scope is required");
const placeholdersOnly = scope === "placeholders";
const sourceInput =
  scope === "nested-missing"
    ? "test/fixtures/i18n-invalid/MissingNestedInterpolation.tsx"
    : scope === "nested-provided"
      ? "test/fixtures/i18n-invalid/ProvidedNestedInterpolation.tsx"
      : "test/fixtures/i18n-invalid/InvalidLocalization.tsx";

export default defineConfig({
  locales: ["en", "ar-XB"],
  extract: {
    input: placeholdersOnly ? configuration.extract.input : [sourceInput],
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
