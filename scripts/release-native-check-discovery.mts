/** GET-only locator discovery. These locators are inert; the actual native
 * consumer must independently authenticate the selected complete reports. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";
import { isDeepStrictEqual } from "node:util";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectNativeQualificationTemplate,
  inspectNativeQualificationCheck,
} from "./release-native-acceptance.mts";
import {
  inspectNativeReleaseQualification,
  nativeQualificationCheckName,
} from "./release-native-qualification-contract.mts";

type Spawn = NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]>;

export function discoverNativeQualificationLocators(
  rawTemplates: readonly unknown[],
  deadline: number,
  options: { api?: GitHubRestReader; spawn?: Spawn } = {},
) {
  if (!Array.isArray(rawTemplates) || rawTemplates.length !== 2)
    throw new Error("native discovery requires the exact fixed template pair");
  const templates = rawTemplates.map(inspectNativeQualificationTemplate);
  if (
    templates.length !== 2 ||
    new Set(templates.map((t) => t.platform_label)).size !== 2 ||
    new Set(templates.map((t) => t.native_app_id)).size !== 1 ||
    new Set(templates.map((t) => t.candidate.source_commit)).size !== 1
  )
    throw new Error("native discovery requires the exact fixed issuer/source/platform pair");
  const app = templates[0]!.native_app_id,
    source = templates[0]!.candidate.source_commit;
  const injectedApi = options.api,
    injectedSpawn = options.spawn;
  const token = process.env.GH_TOKEN;
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    if (!Number.isFinite(deadline) || left < 1)
      throw new Error("native discovery deadline exhausted");
    return coordinatorCommandTimeout(Math.min(left, 15000));
  };
  remaining();
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = injectedApi
    ? undefined
    : mkdtempSync(path.join(temporaryRoot, "native-check-discovery-"));
  if (
    directory &&
    (path.dirname(path.resolve(directory)) !== temporaryRoot ||
      !path.basename(directory).startsWith("native-check-discovery-"))
  )
    throw new Error("native discovery temporary ownership path differs");
  if (directory) chmodSync(directory, 0o700);
  let requests = 0,
    bytes = 0;
  try {
    const runner = createGitHubRunner({
      ...(directory ? { cwd: directory } : {}),
      timeoutMs: 15000,
      maxBuffer: 8 * 1024 * 1024,
      spawn: (command, args, settings) =>
        (injectedSpawn ?? spawnSync)(command, args, {
          ...settings,
          timeout: remaining(),
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GH_TOKEN: token,
            GH_HOST: "github.com",
            GH_CONFIG_DIR: directory,
            HOME: directory,
            USERPROFILE: directory,
            TEMP: directory,
            TMP: directory,
            TMPDIR: directory,
          },
        }),
    });
    const api =
      injectedApi ??
      new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
    const get = (endpoint: string) => {
      remaining();
      if (++requests > 40) throw new Error("native discovery request bound exceeded");
      const response = api.request("GET", endpoint);
      remaining();
      const length = Buffer.byteLength(JSON.stringify(response.body));
      bytes += length;
      if (response.status !== 200 || length > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
        throw new Error("native discovery provider/body bound exceeded");
      const body = structuredClone(response.body);
      remaining();
      return body;
    };
    const snapshot = () => {
      const suites = get(
        `repos/boburning/portcove/commits/${source}/check-suites?app_id=${app}&per_page=100&page=1`,
      );
      if (
        !isRecord(suites) ||
        !Number.isSafeInteger(suites.total_count) ||
        typeof suites.total_count !== "number" ||
        suites.total_count < 0 ||
        suites.total_count > 16 ||
        !Array.isArray(suites.check_suites) ||
        suites.check_suites.length !== suites.total_count
      )
        throw new Error("native complete fixed-App suite inventory missing or excessive");
      const suiteIds = new Set<number>(),
        checkIds = new Set<number>();
      const inventory: { suite: Record<string, unknown>; checks: unknown[] }[] = [],
        matches: { platform_label: string; check_id: number; invocation_id: string }[] = [];
      for (const suite of suites.check_suites) {
        if (
          !isRecord(suite) ||
          typeof suite.id !== "number" ||
          !Number.isSafeInteger(suite.id) ||
          suite.id < 1 ||
          suiteIds.has(suite.id) ||
          suite.head_sha !== source ||
          !isRecord(suite.app) ||
          suite.app.id !== app ||
          !isRecord(suite.repository) ||
          suite.repository.id !== 1354613114 ||
          suite.repository.full_name !== "boburning/portcove"
        )
          throw new Error("native discovery suite issuer/source/repository differs");
        suiteIds.add(suite.id);
        let total: number | undefined;
        const rows: unknown[] = [];
        for (let page = 1; page <= 10; page++) {
          const runs = get(
            `repos/boburning/portcove/check-suites/${suite.id}/check-runs?check_name=${encodeURIComponent(nativeQualificationCheckName)}&filter=all&per_page=100&page=${page}`,
          );
          if (
            !isRecord(runs) ||
            typeof runs.total_count !== "number" ||
            !Number.isSafeInteger(runs.total_count) ||
            runs.total_count < 0 ||
            runs.total_count >= 1000 ||
            !Array.isArray(runs.check_runs) ||
            runs.check_runs.length > 100
          )
            throw new Error(
              "native complete check inventory missing or at provider deletion ceiling",
            );
          total ??= runs.total_count;
          if (total !== runs.total_count)
            throw new Error("native check inventory changed during pagination");
          for (const raw of runs.check_runs) {
            remaining();
            if (
              !isRecord(raw) ||
              typeof raw.id !== "number" ||
              !Number.isSafeInteger(raw.id) ||
              raw.id < 1 ||
              checkIds.has(raw.id) ||
              raw.head_sha !== source ||
              raw.name !== nativeQualificationCheckName ||
              !isRecord(raw.app) ||
              raw.app.id !== app ||
              !isRecord(raw.check_suite) ||
              raw.check_suite.id !== suite.id
            )
              throw new Error(
                "native discovery Check identity duplicates or escapes issuer/source/suite",
              );
            checkIds.add(raw.id);
            rows.push(raw);
            if (raw.status !== "completed" || raw.conclusion !== "success") continue;
            if (
              !isRecord(raw.output) ||
              typeof raw.output.summary !== "string" ||
              Buffer.byteLength(raw.output.summary) > 65536
            )
              throw new Error("native discovery report unavailable or oversized");
            const summary: unknown = JSON.parse(raw.output.summary);
            if (!isRecord(summary)) throw new Error("native discovery summary differs");
            const report = inspectNativeReleaseQualification(summary.report);
            const template = templates.find((t) => t.platform_label === report.platform_label);
            const {
              started_at: _started,
              invocation_id: _invocation,
              ...producer
            } = report.producer;
            const host = {
              machine_id_sha256: report.host.machine_id_sha256,
              qualification_profile: report.host.qualification_profile,
              minimum_platform: report.host.minimum_platform,
              account: report.host.account,
            };
            if (!template) continue;
            const { engine: _engine, ...expectedHost } = template.host;
            if (
              report.schema_version !== template.schema_version ||
              report.native_prepublication_profile !== template.native_prepublication_profile ||
              report.stage !== template.stage ||
              !isDeepStrictEqual(report.candidate, template.candidate) ||
              !isDeepStrictEqual(producer, template.producer) ||
              !isDeepStrictEqual(host, expectedHost) ||
              !isDeepStrictEqual(report.compatibility, template.compatibility) ||
              !isDeepStrictEqual(report.journey, template.journey)
            )
              continue;
            const checked = inspectNativeQualificationCheck(raw, {
              ...template,
              check_id: raw.id,
              producer: { ...template.producer, invocation_id: report.producer.invocation_id },
            });
            matches.push({
              platform_label: report.platform_label,
              check_id: checked.id,
              invocation_id: report.producer.invocation_id,
            });
          }
          if (rows.length > total) throw new Error("native Check inventory exceeds declared total");
          if (rows.length === total) break;
          if (runs.check_runs.length !== 100 || page === 10)
            throw new Error("native Check pagination incomplete");
        }
        inventory.push({
          suite,
          checks: rows.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id),
        });
      }
      return {
        inventory: inventory.sort((a, b) => Number(a.suite.id) - Number(b.suite.id)),
        matches: matches.sort((a, b) => a.platform_label.localeCompare(b.platform_label)),
      };
    };
    const before = snapshot();
    if (
      before.matches.length !== 2 ||
      new Set(before.matches.map((m) => m.platform_label)).size !== 2
    )
      throw new Error("native discovery has no unique complete current stage/platform pair");
    const after = snapshot();
    if (!isDeepStrictEqual(before, after))
      throw new Error("native discovery inventory changed during readback");
    remaining();
    return Object.freeze(before.matches.map((item) => Object.freeze(item)));
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
