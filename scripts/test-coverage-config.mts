import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  constants,
} from "node:fs";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { resolveUiSelection } from "./ui-test-selection.mts";
import type { TestUserConfig } from "vite-plus";

type CoverageMode = "node" | "frontend-unit" | "frontend-browser";
export interface CoverageRequest {
  mode: CoverageMode;
  modules: string[];
  tests: string[];
}
export interface CoveragePacket {
  format_version: 1;
  root: string;
  directory: string;
  request: CoverageRequest;
  node: string;
  custody: ReturnType<typeof coverageCustody>;
}

export function boundedCoverageRead(filename: string, limit: number) {
  const before = lstatSync(filename, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    path.resolve(realpathSync(filename)) !== path.resolve(filename)
  )
    throw new Error("Coverage input must be a regular file without redirects");
  const fd = openSync(
    filename,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const actual = fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino)
      throw new Error("Coverage input physical identity changed");
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    for (;;) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      used += count;
      if (used > limit) throw new Error("Coverage input exceeds byte limit");
      if (!count) return bytes.subarray(0, used);
    }
  } finally {
    closeSync(fd);
  }
}

export function coverageCustody(directory: string) {
  return [directory, path.join(directory, "coverage"), path.join(directory, "maps")].map((file) => {
    const info = lstatSync(file, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      path.resolve(realpathSync(file)) !== path.resolve(file)
    )
      throw new Error("Coverage output physical identity changed or is redirected");
    return { dev: info.dev.toString(), ino: info.ino.toString() };
  });
}

export function assertCoverageCustody(packet: CoveragePacket) {
  if (JSON.stringify(coverageCustody(packet.directory)) !== JSON.stringify(packet.custody))
    throw new Error("Coverage output physical identity changed");
}

const coverageExclusions = [
  "**/node_modules/**",
  "**/src/browser/**",
  "**/*.{test,spec}.*",
  "**/test/**",
  "**/tests/**",
  "**/fixtures/**",
  "**/test-fixtures.*",
  "**/dev-scenarios/**",
  "**/*.generated.*",
  "**/*-fixture.*",
  "**/*-fixtures.*",
  "**/gen/**",
  "**/generated/**",
];

function mode(value: unknown): CoverageMode {
  if (value !== "node" && value !== "frontend-unit" && value !== "frontend-browser")
    throw new Error("Coverage mode must be node, frontend-unit or frontend-browser");
  return value;
}

function selectedFiles(root: string, values: string[], selectedMode: CoverageMode, tests: boolean) {
  if (!values.length || values.length > 16)
    throw new Error("Coverage requires one through sixteen explicit modules and test files");
  const base = selectedMode === "node" ? root : path.join(root, "apps/desktop");
  const files = resolveUiSelection(values, base, tests ? "exact" : "related");
  if (files.length !== values.length) throw new Error("Duplicate coverage selection");
  return files.map((file) => {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (selectedMode === "node") {
      if (!/^scripts\/[^/]+\.(?:test\.)?[cm]?[jt]s$/u.test(relative))
        throw new Error("Node coverage accepts Root script modules and tests");
    } else if (!relative.startsWith("apps/desktop/src/") || !/\.[cm]?[jt]sx?$/u.test(relative)) {
      throw new Error("Frontend coverage accepts Desktop src modules and tests");
    }
    if (tests) {
      const browser = /\.browser\.test\.[jt]sx?$/u.test(relative);
      if (selectedMode !== "node" && browser !== (selectedMode === "frontend-browser"))
        throw new Error("Unit and real-browser coverage require separate test selections");
    } else if (
      /(?:^|\/)(?:test|tests|fixtures|dev-scenarios|gen|generated)(?:\/|$)|(?:^|\/)src\/browser\/|\.(?:test|spec|generated)\.|(?:^|\/)test-fixtures\.|-fixtures?\./u.test(
        relative,
      )
    ) {
      throw new Error("Fixture, test and generated code cannot be selected as production coverage");
    }
    return relative;
  });
}

export function claimCoveragePacket(packet: CoveragePacket) {
  assertCoverageCustody(packet);
  if (readdirSync(path.join(packet.directory, "coverage")).length)
    throw new Error("Coverage output already contains evidence; use a fresh packet");
  writeFileSync(
    path.join(packet.directory, "coverage-started.json"),
    JSON.stringify({ pid: process.pid, node: process.version }) + "\n",
    { flag: "wx" },
  );
}

export function parseCoverageArguments(args: readonly string[], root: string): CoverageRequest {
  const selectedMode = mode(args[0]);
  const modules: string[] = [],
    tests: string[] = [];
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if ((flag !== "--module" && flag !== "--test") || !value || value.startsWith("-"))
      throw new Error("Coverage requires repeated --module FILE and --test FILE arguments");
    (flag === "--module" ? modules : tests).push(value);
  }
  const actualRoot = realpathSync(root);
  return {
    mode: selectedMode,
    modules: selectedFiles(actualRoot, modules, selectedMode, false),
    tests: selectedFiles(actualRoot, tests, selectedMode, true),
  };
}

export function readCoveragePacket(root: string, filename: string): CoveragePacket {
  const bytes = boundedCoverageRead(filename, 64 * 1024);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    value.root !== realpathSync(root) ||
    !isRecord(value.request) ||
    typeof value.directory !== "string" ||
    typeof value.node !== "string" ||
    value.node !== process.version ||
    !Array.isArray(value.custody) ||
    value.custody.length !== 3 ||
    !value.custody.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.dev === "string" &&
        /^\d+$/u.test(entry.dev) &&
        typeof entry.ino === "string" &&
        /^\d+$/u.test(entry.ino),
    ) ||
    !Array.isArray(value.request.modules) ||
    !Array.isArray(value.request.tests) ||
    !value.request.modules.every((f) => typeof f === "string") ||
    !value.request.tests.every((f) => typeof f === "string")
  )
    throw new Error("Invalid coverage packet or runtime identity");
  const relative = path.relative(value.root, value.directory).replaceAll("\\", "/");
  if (!/^work\/test-coverage\/[a-f0-9-]{36}$/u.test(relative))
    throw new Error("Coverage output must be a fresh workspace packet");
  const request = parseCoverageArguments(
    [
      mode(value.request.mode),
      ...value.request.modules.flatMap((f) => ["--module", f]),
      ...value.request.tests.flatMap((f) => ["--test", f]),
    ],
    root,
  );
  const packet: CoveragePacket = {
    format_version: 1,
    root: value.root,
    directory: value.directory,
    request,
    node: value.node,
    custody: value.custody as CoveragePacket["custody"],
  };
  assertCoverageCustody(packet);
  return packet;
}

/** Absent opt-in leaves every ordinary exact/related/shuffled selection unchanged. */
export function frontendCoverageOptions(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Pick<TestUserConfig, "coverage"> & { project?: string[] } {
  const filename = environment.PORTCOVE_UI_COVERAGE_PACKET;
  if (!filename) return {};
  const packet = readCoveragePacket(root, filename);
  if (packet.request.mode === "node")
    throw new Error("Node packet cannot configure frontend coverage");
  claimCoveragePacket(packet);
  return {
    project:
      packet.request.mode === "frontend-unit"
        ? ["unit"]
        : ["browser", "browser-locale", "browser-forced-colors"],
    coverage: {
      enabled: true,
      provider: "v8" as const,
      include: packet.request.modules.map((file) => path.posix.relative("apps/desktop", file)),
      exclude: coverageExclusions,
      reporter: ["json" as const, "lcov" as const, "text" as const],
      reportsDirectory: path.join(packet.directory, "coverage"),
      clean: false,
      reportOnFailure: true,
    },
  };
}
