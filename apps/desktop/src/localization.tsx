import { DirectionProvider } from "@base-ui/react/direction-provider";
import i18next, { type i18n, type Namespace } from "i18next";
import {
  I18nextProvider,
  initReactI18next,
  useTranslation,
  type UseTranslationResponse,
} from "react-i18next";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import englishApplicationUpdate from "./locales/en/applicationUpdate.json";
import englishCatalogUpdates from "./locales/en/catalogUpdates.json";
import englishRemoval from "./locales/en/removal.json";
import englishBackups from "./locales/en/backups.json";
import englishGameSettings from "./locales/en/gameSettings.json";
import englishOrganization from "./locales/en/organization.json";
import englishLauncherImport from "./locales/en/launcherImport.json";
import englishCli from "./locales/en/cli.json";
import englishInstallation from "./locales/en/installation.json";
import englishGameUpdates from "./locales/en/gameUpdates.json";
import englishLaunch from "./locales/en/launch.json";
import englishWorkspace from "./locales/en/workspace.json";
import englishReport from "./locales/en/report.json";
import englishBrowsing from "./locales/en/browsing.json";
import englishCommands from "./locales/en/commands.json";
import englishOperations from "./locales/en/operations.json";
import englishCommon from "./locales/en/common.json";
import englishGameFiles from "./locales/en/gameFiles.json";
import englishCounts from "./locales/en/counts.json";
import englishSettings from "./locales/en/settings.json";
import englishShell from "./locales/en/shell.json";
import engineeringApplicationUpdate from "./locales/ar-XB/applicationUpdate.json";
import engineeringCatalogUpdates from "./locales/ar-XB/catalogUpdates.json";
import engineeringRemoval from "./locales/ar-XB/removal.json";
import engineeringBackups from "./locales/ar-XB/backups.json";
import engineeringGameSettings from "./locales/ar-XB/gameSettings.json";
import engineeringOrganization from "./locales/ar-XB/organization.json";
import engineeringLauncherImport from "./locales/ar-XB/launcherImport.json";
import engineeringCli from "./locales/ar-XB/cli.json";
import engineeringInstallation from "./locales/ar-XB/installation.json";
import engineeringGameUpdates from "./locales/ar-XB/gameUpdates.json";
import engineeringLaunch from "./locales/ar-XB/launch.json";
import engineeringWorkspace from "./locales/ar-XB/workspace.json";
import engineeringReport from "./locales/ar-XB/report.json";
import engineeringBrowsing from "./locales/ar-XB/browsing.json";
import engineeringCommands from "./locales/ar-XB/commands.json";
import engineeringOperations from "./locales/ar-XB/operations.json";
import engineeringCommon from "./locales/ar-XB/common.json";
import engineeringGameFiles from "./locales/ar-XB/gameFiles.json";
import engineeringSettings from "./locales/ar-XB/settings.json";
import engineeringShell from "./locales/ar-XB/shell.json";
import type { LocalePreferenceSnapshot } from "./types";
import draftSpanishSettings from "./locales/es/settings.json";
import draftSpanishCounts from "./locales/es/counts.json";
import draftSpanishShell from "./locales/es/shell.json";
import draftSpanishApplicationUpdate from "./locales/es/applicationUpdate.json";
import draftSpanishCatalogUpdates from "./locales/es/catalogUpdates.json";
import draftSpanishRemoval from "./locales/es/removal.json";
import draftSpanishBackups from "./locales/es/backups.json";
import draftSpanishGameSettings from "./locales/es/gameSettings.json";
import draftSpanishOrganization from "./locales/es/organization.json";
import draftSpanishLauncherImport from "./locales/es/launcherImport.json";
import draftSpanishCli from "./locales/es/cli.json";
import draftSpanishInstallation from "./locales/es/installation.json";
import draftSpanishGameUpdates from "./locales/es/gameUpdates.json";
import draftSpanishLaunch from "./locales/es/launch.json";
import draftSpanishWorkspace from "./locales/es/workspace.json";
import draftSpanishReport from "./locales/es/report.json";
import draftSpanishBrowsing from "./locales/es/browsing.json";
import draftSpanishCommands from "./locales/es/commands.json";
import draftSpanishOperations from "./locales/es/operations.json";
import draftSpanishCommon from "./locales/es/common.json";
import draftSpanishGameFiles from "./locales/es/gameFiles.json";

const supportedLocales = ["en", "ar-XB"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export type LocaleChoice = "system" | SupportedLocale;
export type TextDirection = "ltr" | "rtl";

export const localeOptions: readonly { value: LocaleChoice; key: string }[] = [
  { value: "system", key: "language.system" },
  { value: "en", key: "language.english" },
];

export interface LocalePreferenceApi {
  localePreference(): Promise<LocalePreferenceSnapshot>;
  setLocalePreference(locale: string | null): Promise<LocalePreferenceSnapshot>;
}

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function resolveLocale(
  preference: string | null | undefined,
  systemLocales: readonly string[],
): SupportedLocale {
  const candidates = preference ? [preference] : systemLocales;
  for (const candidate of candidates) {
    const locale = canonicalLocale(candidate);
    if (preference && locale === "ar-XB") return "ar-XB";
    if (locale === "en" || locale?.startsWith("en-")) return "en";
  }
  return "en";
}

export function localeDirection(locale: SupportedLocale): TextDirection {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

function systemLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

export function assertCatalog(
  value: unknown,
  path = "settings",
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid localization catalog at ${path}`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      if (entry.trim().length === 0) throw new Error(`Empty localization value at ${path}.${key}`);
    } else {
      assertCatalog(entry, `${path}.${key}`);
    }
  }
}

export function initializeLocalization(initialLocales = systemLocales()): i18n {
  assertCatalog(englishSettings);
  assertCatalog(englishCounts, "counts");
  assertCatalog(englishShell, "shell");
  assertCatalog(englishApplicationUpdate, "applicationUpdate");
  assertCatalog(englishCatalogUpdates, "catalogUpdates");
  assertCatalog(englishRemoval, "removal");
  assertCatalog(englishBackups, "backups");
  assertCatalog(englishGameSettings, "gameSettings");
  assertCatalog(englishOrganization, "organization");
  assertCatalog(englishLauncherImport, "launcherImport");
  assertCatalog(englishCli, "cli");
  assertCatalog(englishInstallation, "installation");
  assertCatalog(englishGameUpdates, "gameUpdates");
  assertCatalog(englishLaunch, "launch");
  assertCatalog(englishWorkspace, "workspace");
  assertCatalog(englishReport, "report");
  assertCatalog(englishBrowsing, "browsing");
  assertCatalog(englishCommands, "commands");
  assertCatalog(englishOperations, "operations");
  assertCatalog(englishCommon, "common");
  assertCatalog(englishGameFiles, "gameFiles");
  assertCatalog(engineeringSettings);
  assertCatalog(engineeringShell, "shell");
  assertCatalog(engineeringApplicationUpdate, "applicationUpdate");
  assertCatalog(engineeringCatalogUpdates, "catalogUpdates");
  assertCatalog(engineeringRemoval, "removal");
  assertCatalog(engineeringBackups, "backups");
  assertCatalog(engineeringGameSettings, "gameSettings");
  assertCatalog(engineeringOrganization, "organization");
  assertCatalog(engineeringLauncherImport, "launcherImport");
  assertCatalog(engineeringCli, "cli");
  assertCatalog(engineeringInstallation, "installation");
  assertCatalog(engineeringGameUpdates, "gameUpdates");
  assertCatalog(engineeringLaunch, "launch");
  assertCatalog(engineeringWorkspace, "workspace");
  assertCatalog(engineeringReport, "report");
  assertCatalog(engineeringBrowsing, "browsing");
  assertCatalog(engineeringCommands, "commands");
  assertCatalog(engineeringOperations, "operations");
  assertCatalog(engineeringCommon, "common");
  assertCatalog(engineeringGameFiles, "gameFiles");
  assertCatalog(draftSpanishSettings, "es.settings");
  assertCatalog(draftSpanishCounts, "es.counts");
  assertCatalog(draftSpanishShell, "es.shell");
  assertCatalog(draftSpanishApplicationUpdate, "es.applicationUpdate");
  assertCatalog(draftSpanishCatalogUpdates, "es.catalogUpdates");
  assertCatalog(draftSpanishRemoval, "es.removal");
  assertCatalog(draftSpanishBackups, "es.backups");
  assertCatalog(draftSpanishGameSettings, "es.gameSettings");
  assertCatalog(draftSpanishOrganization, "es.organization");
  assertCatalog(draftSpanishLauncherImport, "es.launcherImport");
  assertCatalog(draftSpanishCli, "es.cli");
  assertCatalog(draftSpanishInstallation, "es.installation");
  assertCatalog(draftSpanishGameUpdates, "es.gameUpdates");
  assertCatalog(draftSpanishLaunch, "es.launch");
  assertCatalog(draftSpanishWorkspace, "es.workspace");
  assertCatalog(draftSpanishReport, "es.report");
  assertCatalog(draftSpanishBrowsing, "es.browsing");
  assertCatalog(draftSpanishCommands, "es.commands");
  assertCatalog(draftSpanishOperations, "es.operations");
  assertCatalog(draftSpanishCommon, "es.common");
  assertCatalog(draftSpanishGameFiles, "es.gameFiles");
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: resolveLocale(null, initialLocales),
      fallbackLng: "en",
      supportedLngs: [...supportedLocales, "es"],
      ns: [
        "settings",
        "counts",
        "shell",
        "applicationUpdate",
        "catalogUpdates",
        "removal",
        "backups",
        "gameSettings",
        "organization",
        "launcherImport",
        "cli",
        "installation",
        "gameUpdates",
        "launch",
        "workspace",
        "report",
        "browsing",
        "commands",
        "operations",
        "common",
        "gameFiles",
      ],
      defaultNS: "settings",
      resources: {
        en: {
          settings: englishSettings,
          counts: englishCounts,
          shell: englishShell,
          applicationUpdate: englishApplicationUpdate,
          catalogUpdates: englishCatalogUpdates,
          removal: englishRemoval,
          backups: englishBackups,
          gameSettings: englishGameSettings,
          organization: englishOrganization,
          launcherImport: englishLauncherImport,
          cli: englishCli,
          installation: englishInstallation,
          gameUpdates: englishGameUpdates,
          launch: englishLaunch,
          workspace: englishWorkspace,
          report: englishReport,
          browsing: englishBrowsing,
          commands: englishCommands,
          operations: englishOperations,
          common: englishCommon,
          gameFiles: englishGameFiles,
        },
        "ar-XB": {
          settings: engineeringSettings,
          shell: engineeringShell,
          applicationUpdate: engineeringApplicationUpdate,
          catalogUpdates: engineeringCatalogUpdates,
          removal: engineeringRemoval,
          backups: engineeringBackups,
          gameSettings: engineeringGameSettings,
          organization: engineeringOrganization,
          launcherImport: engineeringLauncherImport,
          cli: engineeringCli,
          installation: engineeringInstallation,
          gameUpdates: engineeringGameUpdates,
          launch: engineeringLaunch,
          workspace: engineeringWorkspace,
          report: engineeringReport,
          browsing: engineeringBrowsing,
          commands: engineeringCommands,
          operations: engineeringOperations,
          common: engineeringCommon,
          gameFiles: engineeringGameFiles,
        },
        // Unreviewed draft pilot (#1028): bundled for review and engineering
        // fixtures only. resolveLocale never selects it and the picker omits it.
        es: {
          settings: draftSpanishSettings,
          counts: draftSpanishCounts,
          shell: draftSpanishShell,
          applicationUpdate: draftSpanishApplicationUpdate,
          catalogUpdates: draftSpanishCatalogUpdates,
          removal: draftSpanishRemoval,
          backups: draftSpanishBackups,
          gameSettings: draftSpanishGameSettings,
          organization: draftSpanishOrganization,
          launcherImport: draftSpanishLauncherImport,
          cli: draftSpanishCli,
          installation: draftSpanishInstallation,
          gameUpdates: draftSpanishGameUpdates,
          launch: draftSpanishLaunch,
          workspace: draftSpanishWorkspace,
          report: draftSpanishReport,
          browsing: draftSpanishBrowsing,
          commands: draftSpanishCommands,
          operations: draftSpanishOperations,
          common: draftSpanishCommon,
          gameFiles: draftSpanishGameFiles,
        },
      },
      initAsync: false,
      returnEmptyString: false,
      returnNull: false,
      parseMissingKeyHandler: () => englishSettings.language.unavailable,
      interpolation: { escapeValue: false },
    });
  }
  return i18next;
}

interface LocalizationState {
  choice: LocaleChoice;
  locale: SupportedLocale;
  direction: TextDirection;
  saving: boolean;
  saved: boolean;
  error: "load" | "save" | "apply" | null;
  select(choice: LocaleChoice): Promise<void>;
}

const defaultLocale = resolveLocale(null, systemLocales());
initializeLocalization();
const LocalizationContext = createContext<LocalizationState>({
  choice: "system",
  locale: defaultLocale,
  direction: localeDirection(defaultLocale),
  saving: false,
  saved: false,
  error: null,
  select: async () => {},
});

export function LocalizationProvider({
  api,
  children,
}: {
  api: LocalePreferenceApi;
  children: ReactNode;
}) {
  const instance = useMemo(() => initializeLocalization(), []);
  const [choice, setChoice] = useState<LocaleChoice>("system");
  const [locale, setLocale] = useState<SupportedLocale>(() => resolveLocale(null, systemLocales()));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<LocalizationState["error"]>(null);
  const preferenceRequest = useRef(0);

  const apply = useCallback(
    async (nextChoice: LocaleChoice) => {
      const nextLocale = resolveLocale(
        nextChoice === "system" ? null : nextChoice,
        systemLocales(),
      );
      await instance.changeLanguage(nextLocale);
      setChoice(nextChoice);
      setLocale(nextLocale);
    },
    [instance],
  );

  useEffect(() => {
    let active = true;
    const request = ++preferenceRequest.current;
    void (async () => {
      let snapshot: LocalePreferenceSnapshot;
      try {
        snapshot = await api.localePreference();
      } catch {
        if (active && request === preferenceRequest.current) setError("load");
        return;
      }
      try {
        if (!active || request !== preferenceRequest.current) return;
        const stored = snapshot.locale;
        const nextChoice: LocaleChoice = stored === "en" || stored === "ar-XB" ? stored : "system";
        await apply(nextChoice);
        if (active && request === preferenceRequest.current) setError(null);
      } catch {
        if (active && request === preferenceRequest.current) setError("apply");
      }
    })();
    return () => {
      // oxlint-disable-next-line react/immutability -- oxc#28401: effect-local binding.
      active = false;
    };
  }, [api, apply]);

  const select = useCallback(
    async (nextChoice: LocaleChoice) => {
      if (nextChoice === choice || saving) return;
      preferenceRequest.current += 1;
      setSaving(true);
      setSaved(false);
      setError(null);
      try {
        const snapshot = await api.setLocalePreference(nextChoice === "system" ? null : nextChoice);
        const persisted = snapshot.locale;
        const persistedChoice: LocaleChoice =
          persisted === "en" || persisted === "ar-XB" ? persisted : "system";
        try {
          await apply(persistedChoice);
          setSaved(true);
        } catch {
          setError("apply");
        }
      } catch {
        setError("save");
      } finally {
        setSaving(false);
      }
    },
    [api, apply, choice, saving],
  );

  const direction = localeDirection(locale);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
  }, [direction, locale]);

  const state = useMemo(
    () => ({ choice, locale, direction, saving, saved, error, select }),
    [choice, direction, error, locale, saved, saving, select],
  );

  return (
    <I18nextProvider i18n={instance}>
      <LocalizationContext.Provider value={state}>
        <DirectionProvider direction={direction}>{children}</DirectionProvider>
      </LocalizationContext.Provider>
    </I18nextProvider>
  );
}

/**
 * Feature translation bound to the module-initialized instance, so migrated
 * surfaces (including render recovery outside the provider) never fall back to
 * raw keys. Locale changes on the shared instance still re-render consumers.
 * Invariant: the global instance is the only runtime i18next instance.
 */
export function useAppTranslation<const N extends Namespace>(ns: N) {
  return useTranslation(ns, { i18n: i18next });
}

export function useLocalization(): LocalizationState &
  Pick<UseTranslationResponse<"settings", undefined>, "t" | "i18n" | "ready"> {
  const state = useContext(LocalizationContext);
  const translation = useTranslation("settings");
  return {
    ...state,
    t: translation.t,
    i18n: translation.i18n,
    ready: translation.ready,
  };
}

// Only availability validation is application policy. i18next owns phrases,
// zero overrides, plural selection, interpolation and number formatting.
type CountMessageKey = {
  [K in keyof typeof englishCounts]: K extends `${infer Key}_unknown` ? Key : never;
}[keyof typeof englishCounts];

type AvailableCount = number | null | undefined;
export function countMessage(
  count: AvailableCount,
  key: "examinedEntries",
  values: { bytes: string },
): string;
export function countMessage(
  count: AvailableCount,
  key: Exclude<CountMessageKey, "examinedEntries">,
): string;
export function countMessage(
  count: AvailableCount,
  key: CountMessageKey,
  values?: { bytes: string },
) {
  const instance = initializeLocalization();
  const bytes = values?.bytes ?? ""; // Required by the examinedEntries overload.
  return count == null || !Number.isSafeInteger(count) || count < 0
    ? instance.t(`${key}_unknown`, { ns: "counts", bytes })
    : instance.t(key, { ns: "counts", count, bytes });
}
