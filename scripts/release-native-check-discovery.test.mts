import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import {
  prepareNativeQualificationCheck,
  inspectNativeQualificationTemplate,
  verifiedNativeReleaseQualification,
} from "./release-native-acceptance.mts";
import { bindNativeQualificationLocators } from "./release-native-admission.mts";
import { discoverNativeQualificationLocators } from "./release-native-check-discovery.mts";
import {
  nativePrepublicationProfile,
  nativePrepublicationPending,
  nativePrepublicationScenarios,
  nativeInitialPackageScenarios,
  nativeEmptyRecordsSha256,
} from "./release-native-qualification-contract.mts";
import { isRecord } from "./runtime-values.mts";

function fixture(
  stage: "payload-signing" | "release-publication" = "payload-signing",
  initial = false,
) {
  const windows = nativeQualificationFixture(stage),
    linux = nativeQualificationFixture(stage);
  linux.platform_label = "linux-x86_64";
  linux.candidate.artifact_id++;
  linux.candidate.package.filename = "Portcove_0.1.0-beta.1_amd64.AppImage";
  linux.producer.invocation_id = "e".repeat(64);
  linux.host.account = { kind: "linux-uid", broker: "1000", qualification: "1001" };
  linux.host.minimum_platform = linux.host.qualification_profile = "ubuntu-24.04-x64";
  linux.host.os_version = "6.8.0";
  linux.host.loaded_engine = { ...linux.host.loaded_engine, name: "WebKitGTK", version: "2.52.6" };
  linux.compatibility.minimum_os_version = "6.8.0";
  linux.runtime.root_creation.kind = "linux-starttime-ticks";
  if (linux.journey)
    linux.journey.predecessor.package.filename = "Portcove_0.1.0-alpha.2_amd64.AppImage";
  const prepared = [windows, linux].map((input) =>
    prepareNativeQualificationCheck(
      stage === "payload-signing"
        ? input
        : {
            ...input,
            schema_version: 2,
            native_prepublication_profile: nativePrepublicationProfile,
            pending_obligations: [...nativePrepublicationPending],
            scenarios: (initial
              ? nativeInitialPackageScenarios
              : nativePrepublicationScenarios
            ).map((name, index) => ({ ...input.scenarios[index], name })),
            ...(initial
              ? {
                  journey: {
                    kind: "initial-empty-feed",
                    metadata_bootstrap_sha256: "1".repeat(64),
                    setup_plan_sha256: "2".repeat(64),
                    initial_site_preimage_sha256: "3".repeat(64),
                    empty_records_sha256: nativeEmptyRecordsSha256,
                    signed_context_sha256: "4".repeat(64),
                    signatures_sha256: "5".repeat(64),
                  },
                }
              : {}),
          },
    ),
  );
  const templates = prepared.map(({ report }) => {
    const { started_at: _start, invocation_id: _invocation, ...producer } = report.producer;
    return inspectNativeQualificationTemplate({
      schema_version: report.schema_version,
      ...(report.schema_version === 2
        ? { native_prepublication_profile: nativePrepublicationProfile }
        : {}),
      native_app_id: 900,
      semantic_app_id: 901,
      classification_app_id: 902,
      stage: report.stage,
      platform_label: report.platform_label,
      candidate: report.candidate,
      producer,
      host: {
        machine_id_sha256: report.host.machine_id_sha256,
        qualification_profile: report.host.qualification_profile,
        minimum_platform: report.host.minimum_platform,
        account: report.host.account,
        engine: {
          name: report.host.loaded_engine.name,
          minimum_version: report.host.loaded_engine.version,
        },
      },
      compatibility: report.compatibility,
      journey: report.journey,
    });
  });
  const suite = {
    id: 500,
    app: { id: 900 },
    head_sha: windows.candidate.source_commit,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
  };
  const rows: Record<string, unknown>[] = prepared.map(({ body }, index) => ({
    ...body,
    id: 501 + index,
    app: { id: 900 },
    check_suite: { id: 500 },
  }));
  let suiteReads = 0;
  const calls: string[] = [];
  let mutate:
    | ((body: Record<string, unknown>, route: string, snapshot: number) => void)
    | undefined;
  const api = {
    request(method: string, route: string, body?: unknown) {
      assert.equal(method, "GET");
      assert.equal(body, undefined);
      calls.push(route);
      let response: Record<string, unknown>;
      if (
        route.includes("/commits/") &&
        route.endsWith("/check-suites?app_id=900&per_page=100&page=1")
      ) {
        suiteReads++;
        response = { total_count: 1, check_suites: [structuredClone(suite)] };
      } else {
        const match =
          /\/check-suites\/500\/check-runs\?check_name=[^&]+&filter=all&per_page=100&page=([1-9][0-9]*)$/u.exec(
            route,
          );
        assert.ok(match, route);
        const page = Number(match[1]);
        response = {
          total_count: rows.length,
          check_runs: structuredClone(rows.slice((page - 1) * 100, page * 100)),
        };
      }
      mutate?.(response, route, suiteReads);
      return { status: 200, body: response, headers: new Map<string, string>() };
    },
  };
  return {
    templates,
    prepared,
    rows,
    suite,
    api,
    calls,
    setMutator(value: typeof mutate) {
      mutate = value;
    },
  };
}
const deadline = () => performance.now() + 120000;
void test("native discovery returns only unique inert exact stage/package locators and final expectation binding stays separate", async () => {
  const f = fixture();
  const locators = discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api });
  assert.equal(f.calls.length, 4);
  assert.deepEqual(
    locators.map((v) => v.check_id),
    [502, 501],
  );
  assert.deepEqual(Object.keys(locators[0]!).sort(), [
    "check_id",
    "invocation_id",
    "platform_label",
  ]);
  const expected = bindNativeQualificationLocators(locators, f.templates);
  assert.equal(expected[0]!.producer.invocation_id, f.prepared[1]!.report.producer.invocation_id);
  assert.throws(() => bindNativeQualificationLocators(undefined, f.templates));
  assert.throws(() => bindNativeQualificationLocators(null, f.templates));
  await assert.rejects(verifiedNativeReleaseQualification(locators[0]!), /actual provider/);
});
void test("native discovery refuses missing, false, wrong issuer and duplicate platform observations", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.rows.pop();
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows[0]!.conclusion = "failure";
    },
    (f: ReturnType<typeof fixture>) => {
      f.suite.app.id = 999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows[0]!.app = { id: 999 };
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows.push({ ...f.rows[0], id: 503 });
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows.push({ ...f.rows[0] });
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows[0]!.head_sha = "0".repeat(40);
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api }),
    );
  }
});
void test("native discovery refuses changed expected inputs, incomplete capture and exact Check wire corruption", () => {
  const original = fixture();
  for (const mutate of [
    (t: typeof original.templates) => {
      t[0]!.candidate.source_tree = "0".repeat(40);
    },
    (t: typeof original.templates) => {
      t[0]!.candidate.package.sha256 = "0".repeat(64);
    },
    (t: typeof original.templates) => {
      t[0]!.producer.source_tree = "0".repeat(40);
    },
    (t: typeof original.templates) => {
      t[0]!.host.machine_id_sha256 = "0".repeat(64);
    },
    (t: typeof original.templates) => {
      t[0]!.compatibility.cli_protocol.max++;
    },
  ]) {
    const f = fixture(),
      changed = structuredClone(f.templates);
    mutate(changed);
    assert.throws(
      () => discoverNativeQualificationLocators(changed, deadline(), { api: f.api }),
      /unique/,
    );
  }
  for (const mutate of [
    (row: Record<string, unknown>) => {
      row.external_id = "changed";
    },
    (row: Record<string, unknown>) => {
      assert.ok(isRecord(row.output));
      const summary: unknown = JSON.parse(String(row.output.summary));
      assert.ok(
        isRecord(summary) &&
          isRecord(summary.report) &&
          isRecord(summary.report.runtime) &&
          isRecord(summary.report.runtime.teardown),
      );
      summary.report.runtime.teardown.tree_empty = false;
      row.output.summary = JSON.stringify(summary);
    },
  ]) {
    const f = fixture();
    mutate(f.rows[0]!);
    assert.throws(() =>
      discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api }),
    );
  }
});
void test("native discovery requires complete stable pagination and brackets returned provider data", () => {
  const f = fixture();
  const pending = Array.from({ length: 100 }, (_, index) => ({
    ...f.rows[0],
    id: 1000 + index,
    status: "in_progress",
  }));
  f.rows.unshift(...pending);
  assert.equal(
    discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api }).length,
    2,
  );
  assert.equal(f.calls.length, 6);
  for (const mutation of ["partial", "ceiling", "changed"] as const) {
    const g = fixture();
    g.setMutator((body, _route, snapshot) => {
      if (!Array.isArray(body.check_runs)) return;
      if (mutation === "partial") body.total_count = 3;
      else if (mutation === "ceiling") body.total_count = 1000;
      else if (snapshot === 2) {
        assert.ok(isRecord(body.check_runs[0]));
        body.check_runs[0].details_url = "https://changed.invalid";
      }
    });
    assert.throws(() =>
      discoverNativeQualificationLocators(g.templates, deadline(), { api: g.api }),
    );
  }
});
void test("native discovery default transport pins github.com and strips ambient hooks/config without granting native authority", (t) => {
  const f = fixture(),
    oldHost = process.env.GH_HOST,
    oldHooks = process.env.NODE_OPTIONS;
  process.env.GH_HOST = "ambient.invalid";
  process.env.NODE_OPTIONS = "--ambient-hook";
  t.after(() => {
    if (oldHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = oldHost;
    if (oldHooks === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldHooks;
  });
  let calls = 0;
  const locators = discoverNativeQualificationLocators(f.templates, deadline(), {
    spawn: (_command, args, settings) => {
      calls++;
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      assert.equal(args[args.indexOf("--method") + 1], "GET");
      assert.equal(settings.env?.GH_HOST, "github.com");
      assert.equal(settings.env?.NODE_OPTIONS, undefined);
      assert.equal(settings.env?.HTTPS_PROXY, undefined);
      assert.match(String(settings.env?.GH_CONFIG_DIR), /native-check-discovery-/);
      const route = args.find((v) => v.startsWith("repos/boburning/portcove/"));
      assert.ok(route);
      const body = f.api.request("GET", route).body;
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
        stderr: "",
      };
    },
  });
  assert.equal(calls, 4);
  assert.equal(locators.length, 2);
  assert.throws(
    () => discoverNativeQualificationLocators(f.templates, performance.now() - 1, { api: f.api }),
    /deadline/,
  );
});

void test("native discovery distinguishes selected report2 initial and predecessor branches and ignores other signed contexts", () => {
  for (const initial of [false, true]) {
    const f = fixture("release-publication", initial);
    const pair = discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api });
    assert.equal(pair.length, 2);
    const changed = structuredClone(f.templates);
    assert.ok(changed[0]!.journey);
    changed[0]!.journey.signed_context_sha256 = "0".repeat(64);
    assert.throws(
      () => discoverNativeQualificationLocators(changed, deadline(), { api: f.api }),
      /unique/,
    );
    const other = fixture("release-publication", !initial);
    f.rows.push({ ...other.rows[0], id: 503 });
    assert.equal(
      discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api }).length,
      2,
    );
  }
});

void test("native discovery never extends an expired inherited role clock or performs a later provider read", async () => {
  const f = fixture();
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 20, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      discoverNativeQualificationLocators(f.templates, deadline(), { api: f.api });
    }),
    /deadline/,
  );
  assert.equal(f.calls.length, 0);
  const g = fixture();
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 100, async () => {
      discoverNativeQualificationLocators(g.templates, deadline(), {
        api: {
          request(method, route) {
            const body = g.api.request(method, route);
            const until = performance.now() + 150;
            while (performance.now() < until) {
              /* inert delayed provider response */
            }
            return body;
          },
        },
      });
    }),
    /deadline/,
  );
  assert.equal(g.calls.length, 1);
});
void test("native discovery default child uses the tighter inherited phase budget", async () => {
  const f = fixture();
  await withCoordinatorDeadline(performance.now() + 1000, async () => {
    const result = discoverNativeQualificationLocators(f.templates, deadline(), {
      spawn: (_command, args, settings) => {
        assert.ok(
          typeof settings.timeout === "number" && settings.timeout > 0 && settings.timeout <= 1000,
        );
        const route = args.find((v) => v.startsWith("repos/boburning/portcove/"));
        assert.ok(route);
        const body = f.api.request("GET", route).body;
        return {
          status: 0,
          stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
          stderr: "",
        };
      },
    });
    assert.equal(result.length, 2);
  });
});
