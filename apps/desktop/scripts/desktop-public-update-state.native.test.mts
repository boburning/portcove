import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import type { WebDriver } from "selenium-webdriver";
import {
  readPublicUserState,
  seedPublicFavorite,
  assertPublicUserStateChoicesPreserved,
} from "./desktop-public-update-state.mts";

void test("pure public update modules import without Selenium or accessibility dependencies", () => {
  const modules = [
    [new URL("./desktop-public-update-state.mts", import.meta.url).href, "readPublicUserState"],
    [
      new URL("./desktop-linux-public-update.mts", import.meta.url).href,
      "inspectLinuxPublicRuntime",
    ],
    [
      new URL("./desktop-windows-public-update.mts", import.meta.url).href,
      "inspectWindowsPublicUpdateConfiguration",
    ],
  ];
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(name, context, next) {
      if (['selenium-webdriver', 'axe-core'].some(pkg => name === pkg || name.startsWith(pkg + '/')))
        throw new Error('Desktop dependency unavailable: ' + name);
      return next(name, context);
    } });
    for (const [url, expected] of ${JSON.stringify(modules)}) {
      const module = await import(url);
      if (typeof module[expected] !== 'function') throw new Error('Missing pure export: ' + expected);
    }
  `,
    ],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 65_536, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
});

function fixture(platform: "win32" | "linux", href: string) {
  const commands: { command: string; args: object | undefined }[] = [];
  const base = platform === "win32" ? "C:\\owned" : "/home/owned";
  const result: Record<string, unknown> = {
    get_bootstrap_status: { ready: true, generation: 7, library_root: `${base}/library` },
    "plugin:path|resolve_directory": `${base}/profile`,
    "plugin:app|version": "1.0.0-beta.2",
    get_favorite_ports: ["catalog-entry"],
    get_application_update_preferences: {
      schema_version: 1,
      revision: 3,
      choice: { channel: "preview", mode: "manual", paused: false },
    },
    get_catalog: { schema_version: 2, ports: [{ id: "z" }, { id: "catalog-entry" }] },
    set_port_favorite: null,
  };
  const browser = {
    executeAsyncScript: async (callback: (...args: unknown[]) => unknown, selected: string) =>
      new Promise<string>((resolve) => {
        runInNewContext(`(${callback.toString()})(selected, done)`, {
          selected,
          done: resolve,
          location: { href, origin: platform === "win32" ? new URL(href).origin : "null" },
          window: {
            __TAURI_INTERNALS__: {
              invoke: async (command: string, args?: object) => {
                commands.push({ command, args });
                assert.ok(Object.hasOwn(result, command));
                return result[command];
              },
            },
          },
          localStorage: { getItem: () => "light" },
          document: { documentElement: { dataset: { theme: "light" } } },
        });
      }),
  } as unknown as WebDriver;
  return { browser, commands, result };
}

for (const platform of ["win32", "linux"] as const)
  void test(`shared actual callbacks use ordinary ${platform} commands and reject foreign packaged origin`, async () => {
    const origin = platform === "win32" ? "http://tauri.localhost" : "tauri://localhost/";
    const local = fixture(platform, origin);
    const favorite = await seedPublicFavorite(local.browser, platform);
    assert.equal(favorite, "catalog-entry");
    const mutation = local.commands.find(({ command }) => command === "set_port_favorite");
    assert.equal(
      JSON.stringify(mutation?.args),
      '{"generation":7,"portId":"catalog-entry","favorite":true}',
    );
    local.commands.length = 0;
    const before = await readPublicUserState(local.browser, platform);
    assert.equal(
      before.application_origin,
      platform === "win32" ? "http://tauri.localhost" : "null",
    );
    assert.equal(before.application_url, origin);
    assert.ok(
      local.commands.every(
        ({ command }) => !command.startsWith("set_") && !command.startsWith("recover_"),
      ),
    );
    const after = {
      ...before,
      application_version: "1.0.0-beta.3",
      update_preferences: { ...before.update_preferences, revision: 4 },
    };
    assert.doesNotThrow(() => assertPublicUserStateChoicesPreserved(before, after));
    assert.throws(() => assertPublicUserStateChoicesPreserved(before, { ...after, favorites: [] }));
    assert.throws(() =>
      assertPublicUserStateChoicesPreserved(before, {
        ...after,
        update_preferences: { schema_version: 1, choice: { channel: "stable", mode: "manual" } },
      }),
    );
    for (const href of [
      "https://untrusted.invalid",
      "tauri://localhost/secondary",
      "tauri://localhost/?query",
      "tauri://localhost.evil/",
    ]) {
      const foreign = fixture(platform, href);
      await assert.rejects(readPublicUserState(foreign.browser, platform));
      await assert.rejects(seedPublicFavorite(foreign.browser, platform));
      assert.equal(foreign.commands.length, 0);
    }
  });
