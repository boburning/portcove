import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWebTheme,
  observeSystemTheme,
  readThemePreference,
  resolveThemePreference,
  syncNativeTheme,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "./theme";

vi.mock("@tauri-apps/api/app", () => ({ setTheme: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme preferences", () => {
  it("defaults missing, invalid, and unreadable preferences to system", () => {
    expect(readThemePreference({ getItem: () => null, setItem: vi.fn() })).toBe("system");
    expect(readThemePreference({ getItem: () => "sepia", setItem: vi.fn() })).toBe("system");
    expect(readThemePreference({ getItem: () => { throw new Error("blocked"); }, setItem: vi.fn() })).toBe("system");
  });

  it("persists an explicit preference without failing on blocked storage", () => {
    const setItem = vi.fn();
    writeThemePreference("light", { getItem: vi.fn(), setItem });
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    expect(() => writeThemePreference("dark", { getItem: vi.fn(), setItem: () => { throw new Error("full"); } })).not.toThrow();
  });

  it("resolves system preferences while explicit choices ignore the OS", () => {
    expect(resolveThemePreference("system", true)).toBe("light");
    expect(resolveThemePreference("system", false)).toBe("dark");
    expect(resolveThemePreference("dark", true)).toBe("dark");
    expect(resolveThemePreference("light", false)).toBe("light");
  });

  it("applies the resolved theme and browser chrome color", () => {
    const meta = { setAttribute: vi.fn() };
    const documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
    vi.stubGlobal("document", { documentElement, querySelector: vi.fn(() => meta) });
    applyWebTheme("light");
    expect(documentElement.dataset.theme).toBe("light");
    expect(documentElement.style.colorScheme).toBe("light");
    expect(meta.setAttribute).toHaveBeenCalledWith("content", "#f5f3ee");
  });

  it("tracks live system changes and removes its listener", () => {
    let listener: ((event: { matches: boolean }) => void) | undefined;
    const query = {
      matches: false,
      addEventListener: vi.fn((_type: string, callback: (event: { matches: boolean }) => void) => { listener = callback; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("window", { matchMedia: vi.fn(() => query) });
    const changed = vi.fn();
    const stop = observeSystemTheme(changed);
    listener?.({ matches: true });
    expect(changed).toHaveBeenCalledWith("light");
    stop();
    expect(query.removeEventListener).toHaveBeenCalledWith("change", listener);
  });

  it("synchronizes explicit and system preferences with Tauri without leaking failures", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(setNativeTheme).mockResolvedValue(undefined);
    await syncNativeTheme("system");
    await syncNativeTheme("dark");
    expect(setNativeTheme).toHaveBeenNthCalledWith(1, null);
    expect(setNativeTheme).toHaveBeenNthCalledWith(2, "dark");
    vi.mocked(setNativeTheme).mockRejectedValueOnce(new Error("native unavailable"));
    await expect(syncNativeTheme("light")).resolves.toBeUndefined();
  });
});
