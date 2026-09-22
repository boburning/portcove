import { DirectionProvider } from "@base-ui/react/direction-provider";
import i18next, { type i18n } from "i18next";
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
  useState,
  type ReactNode,
} from "react";
import englishSettings from "./locales/en/settings.json";
import engineeringSettings from "./locales/ar-XB/settings.json";
import type { LocalePreferenceSnapshot } from "./types";

const supportedLocales = ["en", "ar-XB"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export type LocaleChoice = "system" | SupportedLocale;
export type TextDirection = "ltr" | "rtl";

export const localeOptions: readonly { value: LocaleChoice; key: string }[] = [
  { value: "system", key: "language.system" },
  { value: "en", key: "language.english" },
  { value: "ar-XB", key: "language.engineering" },
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
    if (locale === "ar-XB") return "ar-XB";
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
  assertCatalog(engineeringSettings);
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: resolveLocale(null, initialLocales),
      fallbackLng: "en",
      supportedLngs: [...supportedLocales],
      ns: ["settings"],
      defaultNS: "settings",
      resources: {
        en: { settings: englishSettings },
        "ar-XB": { settings: engineeringSettings },
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
  error: boolean;
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
  error: false,
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
  const [error, setError] = useState(false);

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
    void api
      .localePreference()
      .then((snapshot) => {
        if (!active) return;
        const stored = snapshot.locale;
        const nextChoice: LocaleChoice = stored === "en" || stored === "ar-XB" ? stored : "system";
        return apply(nextChoice);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [api, apply]);

  const select = useCallback(
    async (nextChoice: LocaleChoice) => {
      if (nextChoice === choice || saving) return;
      setSaving(true);
      setSaved(false);
      setError(false);
      try {
        const snapshot = await api.setLocalePreference(nextChoice === "system" ? null : nextChoice);
        const persisted = snapshot.locale;
        const persistedChoice: LocaleChoice =
          persisted === "en" || persisted === "ar-XB" ? persisted : "system";
        await apply(persistedChoice);
        setSaved(true);
      } catch {
        setError(true);
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
