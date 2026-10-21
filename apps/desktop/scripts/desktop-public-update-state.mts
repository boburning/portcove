import assert from "node:assert/strict";
import type { WebDriver } from "selenium-webdriver";
import { isRecord } from "../../../scripts/runtime-values.mts";

export interface PublicUserState {
  application_origin: string;
  application_url: string;
  app_local_data: string;
  application_version: string;
  library_root: string;
  favorites: string[];
  theme_preference: string | null;
  rendered_theme: string;
  update_preferences: Record<string, unknown>;
}

/** Uses shipping Core commands and ordinary localStorage observation; no IPC replacement. */
export async function readPublicUserState(
  browser: WebDriver,
  platform: "win32" | "linux",
): Promise<PublicUserState> {
  assert.ok(platform === "win32" || platform === "linux");
  const expectedOrigin = platform === "win32" ? "http://tauri.localhost" : "tauri://localhost";
  const raw = await browser.executeAsyncScript<string>(
    (platform: "win32" | "linux", done: (result: string) => void) => {
      const bridge = (
        window as Window & {
          __TAURI_INTERNALS__?: {
            invoke(command: string, args?: object): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (
        !bridge ||
        !(platform === "win32"
          ? location.origin === "http://tauri.localhost"
          : /^tauri:\/\/localhost\/?$/u.test(location.href))
      )
        return done('{"ok":false}');
      void (async () => {
        const boot = (await bridge.invoke("get_bootstrap_status")) as {
          ready: boolean;
          library_root: string;
          generation: number;
        };
        if (!boot.ready) throw new Error("ordinary library unavailable");
        const value = {
          application_origin: location.origin,
          application_url: location.href,
          app_local_data: await bridge.invoke("plugin:path|resolve_directory", { directory: 15 }),
          application_version: await bridge.invoke("plugin:app|version"),
          library_root: boot.library_root,
          favorites: await bridge.invoke("get_favorite_ports", { generation: boot.generation }),
          theme_preference: localStorage.getItem("portcove.appearance.theme"),
          rendered_theme: document.documentElement.dataset.theme,
          update_preferences: await bridge.invoke("get_application_update_preferences"),
        };
        const text = JSON.stringify({ ok: true, value });
        done(text.length <= 16384 ? text : '{"ok":false}');
      })().catch(() => done('{"ok":false}'));
    },
    platform,
  );
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 65536);
  const reply: unknown = JSON.parse(raw);
  assert.ok(isRecord(reply) && reply.ok === true && isRecord(reply.value));
  const value = reply.value;
  if (platform === "win32") assert.equal(value.application_origin, expectedOrigin);
  else {
    assert.ok(value.application_origin === "null" || value.application_origin === expectedOrigin);
    assert.ok(
      typeof value.application_url === "string" &&
        /^tauri:\/\/localhost\/?$/u.test(value.application_url),
    );
  }
  assert.ok(
    typeof value.application_url === "string" &&
      value.application_url.length > 0 &&
      value.application_url.length <= 32768,
  );
  assert.ok(
    typeof value.app_local_data === "string" &&
      value.app_local_data.length > 0 &&
      value.app_local_data.length <= 32768,
  );
  assert.ok(
    typeof value.application_version === "string" && value.application_version.length <= 128,
  );
  assert.ok(
    typeof value.library_root === "string" &&
      value.library_root.length > 0 &&
      value.library_root.length <= 32768,
  );
  assert.ok(Array.isArray(value.favorites) && value.favorites.length <= 1000);
  const favorites = value.favorites.map((id) => {
    assert.ok(typeof id === "string" && id.length <= 256);
    return id;
  });
  assert.ok(
    value.theme_preference === null ||
      value.theme_preference === "system" ||
      value.theme_preference === "light" ||
      value.theme_preference === "dark",
  );
  assert.ok(value.rendered_theme === "light" || value.rendered_theme === "dark");
  assert.ok(isRecord(value.update_preferences));
  return {
    application_origin: String(value.application_origin),
    application_url: value.application_url,
    app_local_data: value.app_local_data,
    application_version: value.application_version,
    library_root: value.library_root,
    favorites: favorites.sort(),
    theme_preference: value.theme_preference as string | null,
    rendered_theme: value.rendered_theme,
    update_preferences: value.update_preferences,
  };
}

export function assertPublicUserStateChoicesPreserved(
  before: PublicUserState,
  after: PublicUserState,
) {
  assert.equal(after.application_origin, before.application_origin);
  assert.ok(
    before.favorites.length > 0,
    "An empty library choice cannot prove user-state preservation",
  );
  assert.deepEqual(after.favorites, before.favorites);
  assert.equal(before.theme_preference, "light", "Ordinary appearance seed was not observed");
  assert.equal(after.theme_preference, before.theme_preference);
  assert.equal(after.rendered_theme, before.rendered_theme);
  assert.equal(before.update_preferences.schema_version, 1);
  assert.equal(after.update_preferences.schema_version, before.update_preferences.schema_version);
  assert.ok(isRecord(before.update_preferences.choice));
  assert.equal(before.update_preferences.choice.channel, "preview");
  assert.equal(before.update_preferences.choice.mode, "manual");
  assert.deepEqual(after.update_preferences.choice, before.update_preferences.choice);
}

export async function seedPublicFavorite(browser: WebDriver, platform: "win32" | "linux") {
  assert.ok(platform === "win32" || platform === "linux");
  const raw = await browser.executeAsyncScript<string>(
    (platform: "win32" | "linux", done: (result: string) => void) => {
      const bridge = (
        window as Window & {
          __TAURI_INTERNALS__?: { invoke(command: string, args?: object): Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      if (
        !bridge ||
        !(platform === "win32"
          ? location.origin === "http://tauri.localhost"
          : /^tauri:\/\/localhost\/?$/u.test(location.href))
      )
        return done('{"ok":false}');
      void (async () => {
        const boot = (await bridge.invoke("get_bootstrap_status")) as {
          ready: boolean;
          generation: number;
        };
        const catalog = (await bridge.invoke("get_catalog")) as {
          schema_version: number;
          ports: { id: string }[];
        };
        if (!boot.ready || catalog.schema_version !== 2 || !Array.isArray(catalog.ports))
          throw new Error("current Gen2 catalog required");
        const ids = catalog.ports
          .map((port) => port.id)
          .filter((id) => typeof id === "string")
          .sort();
        if (!ids.length || ids[0]!.length > 256) throw new Error("current catalog entry required");
        await bridge.invoke("set_port_favorite", {
          generation: boot.generation,
          portId: ids[0],
          favorite: true,
        });
        done(JSON.stringify({ ok: true, port_id: ids[0] }));
      })().catch(() => done('{"ok":false}'));
    },
    platform,
  );
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 1024);
  const result: unknown = JSON.parse(raw);
  assert.ok(isRecord(result) && result.ok === true && typeof result.port_id === "string");
  return result.port_id;
}

/** Ordinary Settings interaction shared by both packaged platform harnesses. */
export async function selectPublicLightTheme(browser: WebDriver) {
  const { By } = await import("selenium-webdriver");
  await browser
    .findElement(By.xpath('//nav//button[.//span[normalize-space(.)="Settings"]]'))
    .click();
  await browser
    .findElement(
      By.xpath('//*[@aria-label="Settings sections"]//button[normalize-space(.)="Appearance"]'),
    )
    .click();
  await browser
    .findElement(By.xpath('//*[@aria-label="Color theme"]//button[normalize-space(.)="Light"]'))
    .click();
}
