/** GET-only locator discovery. These locators are inert; the actual native
 * consumer must independently authenticate the selected complete reports. */
import { performance } from "node:perf_hooks";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";
import { isDeepStrictEqual } from "node:util";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectNativeQualificationTemplate,
  inspectNativeQualificationCheck,
} from "./release-native-acceptance.mts";
import {
  inspectNativeReleaseQualification,
  nativeQualificationCheckName,
} from "./release-native-qualification-contract.mts";

export interface NativeCheckDiscoveryOperations {
  suites(): Promise<unknown>;
  checks(suite: number, page: number): Promise<unknown>;
}

/** Fixed source/App metadata only; returned locators never establish acceptance. */
export async function createNativeCheckDiscoveryOperations(options: {
  source: string;
  app: number;
  deadline: number;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}): Promise<NativeCheckDiscoveryOperations> {
  const { source, app, deadline, fetch: configuredFetch } = options;
  const started = performance.now();
  const left = Math.floor(deadline - started);
  if (!Number.isFinite(deadline) || left < 1)
    throw new Error("native discovery deadline exhausted");
  const originalDeadline = Math.min(
    deadline,
    started + coordinatorCommandTimeout(Math.min(left, 2_147_483_647)),
  );
  if (!/^[a-f0-9]{40}$/u.test(source) || !Number.isSafeInteger(app) || app < 1)
    throw new Error("native discovery requires exact source/App identity");
  const environment = options.environment ?? readOnlyReleaseChildEnvironment() ?? process.env;
  const token = environment.GH_TOKEN;
  if (!token) throw new Error("explicit native discovery reader credential required");
  const { createGitHubClient } = await import("./github-client.mts");
  const suites = `/repos/boburning/portcove/commits/${source}/check-suites`;
  const runs = /^\/repos\/boburning\/portcove\/check-suites\/[1-9][0-9]*\/check-runs$/u;
  let attempts = 0,
    bytes = 0;
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: originalDeadline,
    maxBytes: 8 * 1024 ** 2,
    requestTimeoutMs: 15000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(configuredFetch ? { fetch: configuredFetch } : {}),
    allowRequest(method, url) {
      if (method !== "GET") return false;
      if (url.pathname === suites) return url.search === `?app_id=${app}&per_page=100&page=1`;
      return (
        runs.test(url.pathname) &&
        [...url.searchParams.keys()].sort().join(",") === "check_name,filter,page,per_page" &&
        url.searchParams.get("check_name") === nativeQualificationCheckName &&
        url.searchParams.get("filter") === "all" &&
        url.searchParams.get("per_page") === "100" &&
        /^(?:[1-9]|10)$/u.test(url.searchParams.get("page") ?? "")
      );
    },
    reserve() {
      if (++attempts > 40) throw new Error("native discovery request bound exceeded");
      return {
        consumeBytes(length) {
          bytes += length;
          if (bytes > 32 * 1024 ** 2)
            throw new Error("native discovery provider/body bound exceeded");
        },
        settle() {},
      };
    },
  });
  const get = async (path: string) => {
    const response = await sdk.request({
      method: "GET",
      url: `https://api.github.com${path}`,
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    if (response.status !== 200) throw new Error("native discovery provider read unavailable");
    return response.data as unknown;
  };
  return {
    suites: () => get(`${suites}?app_id=${app}&per_page=100&page=1`),
    checks(suite, page) {
      if (
        !Number.isSafeInteger(suite) ||
        suite < 1 ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 10
      )
        throw new Error("native discovery page identity differs");
      return get(
        `/repos/boburning/portcove/check-suites/${suite}/check-runs?check_name=${encodeURIComponent(nativeQualificationCheckName)}&filter=all&per_page=100&page=${page}`,
      );
    },
  };
}

export async function discoverNativeQualificationLocators(
  rawTemplates: readonly unknown[],
  deadline: number,
  options: { operations?: NativeCheckDiscoveryOperations } = {},
) {
  if (!Array.isArray(rawTemplates) || rawTemplates.length !== 2)
    throw new Error("native discovery requires the exact fixed template pair");
  const templates = structuredClone(rawTemplates).map(inspectNativeQualificationTemplate);
  if (
    templates.length !== 2 ||
    new Set(templates.map((t) => t.platform_label)).size !== 2 ||
    new Set(templates.map((t) => t.native_app_id)).size !== 1 ||
    new Set(templates.map((t) => t.candidate.source_commit)).size !== 1
  )
    throw new Error("native discovery requires the exact fixed issuer/source/platform pair");
  const app = templates[0]!.native_app_id,
    source = templates[0]!.candidate.source_commit;
  const injectedOperations = options.operations;
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    if (!Number.isFinite(deadline) || left < 1)
      throw new Error("native discovery deadline exhausted");
    return coordinatorCommandTimeout(Math.min(left, 15000));
  };
  remaining();
  const operations =
    injectedOperations ?? (await createNativeCheckDiscoveryOperations({ source, app, deadline }));
  let requests = 0,
    bytes = 0;
  const get = async (operation: () => Promise<unknown>) => {
    remaining();
    if (++requests > 40) throw new Error("native discovery request bound exceeded");
    const response = await operation();
    remaining();
    const length = Buffer.byteLength(JSON.stringify(response));
    bytes += length;
    if (length > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
      throw new Error("native discovery provider/body bound exceeded");
    const body = structuredClone(response);
    remaining();
    return body;
  };
  const snapshot = async () => {
    const suites = await get(() => operations.suites());
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
      const suiteId = suite.id;
      suiteIds.add(suiteId);
      let total: number | undefined;
      const rows: unknown[] = [];
      for (let page = 1; page <= 10; page++) {
        const runs = await get(() => operations.checks(suiteId, page));
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
          const { started_at: _started, invocation_id: _invocation, ...producer } = report.producer;
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
  const before = await snapshot();
  if (
    before.matches.length !== 2 ||
    new Set(before.matches.map((m) => m.platform_label)).size !== 2
  )
    throw new Error("native discovery has no unique complete current stage/platform pair");
  const after = await snapshot();
  if (!isDeepStrictEqual(before, after))
    throw new Error("native discovery inventory changed during readback");
  remaining();
  return Object.freeze(before.matches.map((item) => Object.freeze(item)));
}
