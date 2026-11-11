import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en", "ar-XB"],
  extract: {
    // Migrated first-party surfaces. Listing a file here makes `i18n:check` reject
    // new hardcoded copy in it; see docs/LOCALIZATION.md#migration-inventory.
    input: [
      "src/localization.tsx",
      "src/components/LanguageSettings.tsx",
      "src/ErrorBoundary.tsx",
      "src/InterfaceSize.tsx",
      "src/features/application-update/ApplicationUpdateNotices.tsx",
      "src/features/application-update/ApplicationUpdates.tsx",
      "src/components/OfficialDefinitionUpdates.tsx",
      "src/components/OfficialCatalogUpdates.tsx",
    ],
    ignore: ["src/**/*.test.{ts,tsx}", "src/**/*.generated.d.ts", "src/design-compatibility/**"],
    output: "src/locales/{{language}}/{{namespace}}.json",
    defaultNS: "settings",
    // `useAppTranslation` binds feature namespaces to the initialized instance.
    useTranslationNames: ["useTranslation", "useAppTranslation"],
    primaryLanguage: "en",
    secondaryLanguages: ["ar-XB"],
    removeUnusedKeys: false,
    sort: true,
    extractFromComments: false,
    warnOnConflicts: true,
  },
  lint: {
    ignore: ["src/localization.tsx"],
    // Technical design-system and ARIA-reference literals, never player copy.
    ignoredAttributes: [
      "aria-live",
      "aria-atomic",
      "aria-describedby",
      "aria-labelledby",
      "data-slot",
      "intent",
      "size",
      "variant",
    ],
    acceptedTags: [],
    acceptedAttributes: [],
    checkInterpolationParams: true,
    checkTranslationPlaceholders: "error",
    checkConcatenation: "error",
  },
  types: {
    input: ["src/locales/en/*.json"],
    basePath: "src/locales/en",
    output: "src/i18next.d.ts",
    resourcesFile: "src/resources.generated.d.ts",
  },
});
