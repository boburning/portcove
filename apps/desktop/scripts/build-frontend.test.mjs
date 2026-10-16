import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { build } from "vite";

import { expect, it, vi } from "vite-plus/test";
import config from "../vite.config.ts";
import { frontendEnvironment, buildFrontend } from "./build-frontend.mjs";
import { vitePlusCommand } from "../../../scripts/viteplus-cli.mjs";

it("processes imported CSS, nesting, utilities and local assets through the selected transformer", async () => {
  const fixture = await mkdtemp(new URL("../../../work/css-pipeline-", import.meta.url));
  const entry = path.join(fixture, "entry.js");
  const stylesheet = path.join(fixture, "probe.css");
  const options = {
    ...config,
    root: fixture,
    configFile: false,
    logLevel: "silent",
    build: {
      ...config.build,
      write: false,
      assetsInlineLimit: 0,
      rolldownOptions: { input: path.join(fixture, "index.html") },
    },
  };
  try {
    await writeFile(
      path.join(fixture, "pixel.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    );
    await writeFile(
      stylesheet,
      '@layer components { .pipeline-probe { & > span { background-image: url("./pixel.svg"); color: var(--color-text); } } }',
    );
    await writeFile(
      entry,
      `import ${JSON.stringify(fileURLToPath(new URL("../src/styles/index.css", import.meta.url)))};\nimport "./probe.css";\nglobalThis.pipeline = true;`,
    );
    await writeFile(
      path.join(fixture, "index.html"),
      '<script type="module" src="./entry.js"></script>',
    );
    const result = await build(options);
    const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const css = output
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) => String(item.source))
      .join("\n");
    expect(config.css.transformer).toBe("lightningcss");
    expect(config.build.cssTarget).toEqual(["chrome111", "safari16.4"]);
    expect(css).toContain(".pipeline-probe>span");
    expect(css).not.toContain("& > span");
    expect(css).not.toContain("12345px");
    const asset = output.find((item) => item.type === "asset" && item.fileName.endsWith(".svg"));
    expect(asset).toBeDefined();
    expect(css).toContain(path.posix.basename(asset.fileName));
    expect(output.some((item) => item.type === "asset" && item.fileName.endsWith(".woff2"))).toBe(
      true,
    );
    expect(output.some((item) => item.fileName.endsWith(".map"))).toBe(true);
    await writeFile(stylesheet, ".pipeline-probe { color: rgb( } broken");
    await expect(build(options)).rejects.toThrow(/probe\.css|Unexpected|Invalid/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function installedCliFixture(directory) {
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const installed = path.join(directory, "node_modules/vite-plus");
  await mkdir(path.join(installed, "bin"), { recursive: true });
  await writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({
      name: "vite-plus",
      version: "1.2.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
      bin: { vp: "bin/vp" },
    }),
  );
  await writeFile(path.join(installed, "bin/vp"), "#!/usr/bin/env node\nprocess.exit(0);\n");
}

it.each([false, true])(
  "refuses an output link before invoking the child (dangling=%s)",
  async (dangling) => {
    const fixture = await mkdtemp(new URL("../../../work/frontend-link-", import.meta.url));
    const outside = await mkdtemp(new URL("../../../work/frontend-outside-", import.meta.url));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await installedCliFixture(fixture);
      await writeFile(path.join(outside, "keep.txt"), "outside data");
      await symlink(
        dangling ? path.join(outside, "missing") : outside,
        path.join(fixture, "dist"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const run = vi.fn();
      expect(buildFrontend(process.env, run, false, fixture)).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("ordinary owned directory"));
      expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside data");
      expect(existsSync(path.join(outside, "missing"))).toBe(false);
    } finally {
      log.mockRestore();
      await rm(fixture, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

it("preserves a failing child's exit and newly emitted partial output", async () => {
  const fixture = await mkdtemp(new URL("../../../work/frontend-failure-", import.meta.url));
  try {
    await installedCliFixture(fixture);
    await mkdir(path.join(fixture, "dist"));
    await writeFile(path.join(fixture, "dist/stale.txt"), "old output");
    const status = buildFrontend(
      process.env,
      () => {
        expect(existsSync(path.join(fixture, "dist"))).toBe(false);
        mkdirSync(path.join(fixture, "dist"));
        writeFileSync(path.join(fixture, "dist/partial.txt"), "failed build evidence");
        return { status: 23 };
      },
      false,
      fixture,
    );
    expect(status).toBe(23);
    expect(await readFile(path.join(fixture, "dist/partial.txt"), "utf8")).toBe(
      "failed build evidence",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

it("removes signing inputs before frontend children while preserving native inputs", () => {
  const environment = {
    TAURI_SIGNING_PRIVATE_KEY: "fake-key",
    tauri_signing_private_key_password: "fake-password",
    TAURI_ENV_PLATFORM: "windows",
    VITE_PUBLIC_LABEL: "public",
    PATH: "tools",
  };
  expect(frontendEnvironment(environment)).toEqual({
    TAURI_ENV_PLATFORM: "windows",
    VITE_PUBLIC_LABEL: "public",
    PATH: "tools",
  });
  expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBe("fake-key");
});

it("excludes signing sentinels from direct and whole-object frontend access and maps", async () => {
  const names = [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "VITE_PUBLIC_LABEL",
  ];
  const previous = names.map((name) => process.env[name]);
  const fixture = await mkdtemp(new URL("../../../work/env-probe-", import.meta.url));
  const entry = `${fixture}/entry.js`;
  const sentinels = ["fake-only-key-1279", "fake-only-password-1279"];
  try {
    process.env[names[0]] = sentinels[0];
    process.env[names[1]] = sentinels[1];
    process.env[names[2]] = "public-1279";
    await writeFile(
      entry,
      `import ${JSON.stringify(fileURLToPath(new URL("../src/styles/index.css", import.meta.url)))};\nglobalThis.probe = { direct: import.meta.env.TAURI_SIGNING_PRIVATE_KEY, password: import.meta.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, all: import.meta.env };`,
    );
    const result = await build({
      ...config,
      root: fileURLToPath(new URL("../", import.meta.url)),
      configFile: false,
      logLevel: "silent",
      build: {
        ...config.build,
        write: false,
        lib: { entry, formats: ["iife"], name: "EnvironmentProbe" },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const context = {};
    for (const output of outputs) {
      const contents = output.type === "chunk" ? output.code : String(output.source);
      for (const sentinel of sentinels) expect(contents).not.toContain(sentinel);
      if (output.type === "chunk") runInNewContext(output.code, context);
    }
    expect(outputs.some((output) => output.fileName.endsWith(".map"))).toBe(true);
    expect(context.probe.direct).toBeUndefined();
    expect(context.probe.password).toBeUndefined();
    expect(context.probe.all.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(context.probe.all.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
    expect(context.probe.all.VITE_PUBLIC_LABEL).toBe("public-1279");
  } finally {
    await rm(fixture, { recursive: true, force: true });
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
});

it("rejects an emitted application build with no current CSS", async () => {
  const fixture = await mkdtemp(new URL("../../../work/css-output-probe-", import.meta.url));
  try {
    const entry = path.join(fixture, "entry.js");
    await writeFile(entry, "globalThis.cssOutputProbe = true;");
    await expect(
      build({
        ...config,
        root: fileURLToPath(new URL("../", import.meta.url)),
        configFile: false,
        logLevel: "silent",
        build: {
          ...config.build,
          write: false,
          lib: { entry, formats: ["iife"], name: "CssOutputProbe" },
        },
      }),
    ).rejects.toThrow("production CSS output is empty");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

it("uses resolved public environment for the explicit compatibility fixture boundary", async () => {
  const fixture = await mkdtemp(new URL("../../../work/design-env-probe-", import.meta.url));
  const previous = process.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE;
  delete process.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE;
  try {
    const entry = path.join(fixture, "entry.js");
    await writeFile(
      entry,
      `import ${JSON.stringify(fileURLToPath(new URL("../src/styles/index.css", import.meta.url)))};\nimport ${JSON.stringify(fileURLToPath(new URL("../src/design-compatibility/design-compatibility.css", import.meta.url)))};\nglobalThis.designProbe = true;`,
    );
    const buildProbe = () =>
      build({
        ...config,
        root: fileURLToPath(new URL("../", import.meta.url)),
        envDir: fixture,
        configFile: false,
        logLevel: "silent",
        build: {
          ...config.build,
          write: false,
          lib: { entry, formats: ["iife"], name: "DesignProbe" },
        },
      });
    await expect(buildProbe()).rejects.toThrow("Design compatibility fixture cannot ship");
    await writeFile(
      path.join(fixture, ".env.production"),
      "VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE=1\n",
    );
    const result = await buildProbe();
    const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const fixtureCss = output
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) => String(item.source))
      .join("\n");
    expect(fixtureCss).toContain("dark\\:opacity-50");
    expect(process.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE;
    else process.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE = previous;
    await rm(fixture, { recursive: true, force: true });
  }
});
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";

it.each([false, true])(
  "build entrypoints strip signing inputs before the toolchain (fresh=%s)",
  async (fresh) => {
    const nativeConfig = JSON.parse(
      await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    );
    expect(nativeConfig.build.beforeBuildCommand).toBe("node scripts/build-frontend.mjs");
    const rootPackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    const appPackage = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(rootPackage.scripts.build).toBe("node apps/desktop/scripts/build-frontend.mjs");
    expect(appPackage.scripts.build).toBe("node scripts/build-frontend.mjs");
    expect(rootPackage.scripts["build:cached"]).toBeUndefined();
    expect(appPackage.scripts["build:cached"]).toBeUndefined();
    const fixture = await mkdtemp(new URL("../../../work/frontend-child-", import.meta.url));
    const child = path.join(fixture, "observe.mjs");
    const marker = path.join(fixture, "observed.json");
    try {
      await installedCliFixture(fixture);
      await mkdir(path.join(fixture, "dist"));
      await writeFile(path.join(fixture, "dist/stale.txt"), "stale generated output");
      await writeFile(
        child,
        `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},JSON.stringify({signing:process.env.TAURI_SIGNING_PRIVATE_KEY??null,native:process.env.TAURI_ENV_PLATFORM,args:process.argv.slice(2)}));`,
      );
      let childResult;
      const status = buildFrontend(
        {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY: "fake-only-child-key",
          TAURI_ENV_PLATFORM: "windows",
        },
        (command, args, options) => {
          expect(command).toBe(process.execPath);
          expect(options.cwd).toBe(fixture);
          expect(existsSync(path.join(fixture, "dist"))).toBe(false);
          childResult = spawnSync(process.execPath, [child, ...args], {
            ...options,
            stdio: "pipe",
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
          });
          return childResult;
        },
        fresh,
        fixture,
      );
      const result = childResult;
      expect(status).toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
        signing: null,
        native: "windows",
        args: [
          ...vitePlusCommand(fixture).args,
          "run",
          ...(fresh ? ["--no-cache"] : []),
          "frontend:bundle",
        ],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
