// Private subprocess fixture: every potentially expensive operation is mocked.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(desktop, "../..");
assert.ok(process.env.PORTCOVE_BOOTSTRAP_CONTROL_ROOT);
const controlRoot = realpathSync(process.env.PORTCOVE_BOOTSTRAP_CONTROL_ROOT);
const mode = process.env.PORTCOVE_BOOTSTRAP_CONTROL;
const observe = (operation: string) => console.log(`Browser bootstrap control: ${operation}`);
const resourceUrl = new URL("../../../scripts/resource-command.mts", import.meta.url);
const resources = await import("../../../scripts/resource-command.mts");
mock.module(resourceUrl.href, {
  namedExports: {
    ...resources,
    resourceEntrypoint: async (_kind: string, run: () => Promise<number>) => run(),
  },
});
const storageUrl = new URL("../../../scripts/dev-storage.mts", import.meta.url);
const storage = await import("../../../scripts/dev-storage.mts");
mock.module(storageUrl.href, {
  namedExports: {
    ...storage,
    resolvePhysicalPath: (value: string) =>
      value === root
        ? controlRoot
        : value === path.join(root, "work/browser-cache")
          ? path.join(controlRoot, "work/browser-cache")
          : storage.resolvePhysicalPath(value),
    spawnCommand: (command: string, args: string[], options: { cwd: string }) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [
        path.join(desktop, "node_modules", "playwright", "cli.js"),
        "install",
        "--only-shell",
        "chromium",
      ]);
      assert.equal(options.cwd, desktop);
      observe("install");
      return { status: mode === "install-failure" ? 23 : mode === "install-signal" ? null : 0 };
    },
  },
});
mock.module("playwright", {
  namedExports: {
    chromium: {
      executablePath: () => path.join(root, "work/browser-cache/owned-full-control/chrome.exe"),
      launch: async (options: unknown) => {
        assert.deepEqual(options, { headless: true });
        observe("launch");
        if (mode === "launch-failure") throw new Error("OWNED_BROWSER_LAUNCH_FAILURE");
        return {
          version: () => "owned-control-version",
          close: async () => {
            observe("close");
            if (mode === "close-failure") throw new Error("OWNED_BROWSER_CLOSE_FAILURE");
          },
        };
      },
    },
  },
});
const requirePlaywright = createRequire(import.meta.resolve("playwright"));
mock.module(requirePlaywright.resolve("playwright-core/lib/coreBundle"), {
  namedExports: {
    registry: {
      registry:
        mode === "registry-unknown"
          ? {}
          : {
              findExecutable: (name: string) => {
                assert.equal(name, "chromium-headless-shell");
                return {
                  executablePath: () =>
                    mode === "shell-outside"
                      ? path.join(controlRoot, "foreign/chrome.exe")
                      : path.join(controlRoot, "work/browser-cache/owned-shell-control/chrome.exe"),
                };
              },
            },
    },
  },
});
