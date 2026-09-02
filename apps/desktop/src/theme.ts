import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "portcove.appearance.theme";

const LIGHT_THEME_QUERY = "(prefers-color-scheme: light)";
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: "#191a1d",
  light: "#f5f3ee",
};

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light";
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function lightThemeQuery(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return window.matchMedia(LIGHT_THEME_QUERY);
}

export function readThemePreference(storage = browserStorage()): ThemePreference {
  try {
    const preference = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemePreference(preference) ? preference : "system";
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference: ThemePreference, storage = browserStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked or full storage area should not prevent changing the active theme.
  }
}

export function resolveThemePreference(preference: ThemePreference, systemPrefersLight = lightThemeQuery()?.matches ?? false): ResolvedTheme {
  return preference === "system" ? systemPrefersLight ? "light" : "dark" : preference;
}

export function applyWebTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

export async function syncNativeTheme(preference: ThemePreference): Promise<void> {
  if (!isTauri()) return;
  try {
    await setNativeTheme(preference === "system" ? null : preference);
  } catch {
    // CSS remains authoritative if native window chrome cannot be updated.
  }
}

function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveThemePreference(preference);
  applyWebTheme(resolved);
  void syncNativeTheme(preference);
  return resolved;
}

export function initializeTheme(): ResolvedTheme {
  return applyThemePreference(readThemePreference());
}

export function observeSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  const query = lightThemeQuery();
  if (!query) return () => undefined;
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches ? "light" : "dark");
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }
  query.addListener(handleChange);
  return () => query.removeListener(handleChange);
}

export interface ThemeState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export function useThemePreference(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveThemePreference(preference));

  useEffect(() => {
    const resolved = applyThemePreference(preference);
    setResolvedTheme(resolved);
    if (preference !== "system") return undefined;
    return observeSystemTheme(nextTheme => {
      applyWebTheme(nextTheme);
      setResolvedTheme(nextTheme);
    });
  }, [preference]);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    writeThemePreference(nextPreference);
    setPreferenceState(nextPreference);
    setResolvedTheme(applyThemePreference(nextPreference));
  }, []);

  return { preference, resolvedTheme, setPreference };
}
