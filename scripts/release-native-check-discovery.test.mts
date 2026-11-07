import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import {
  prepareNativeQualificationCheck,
  inspectNativeQualificationTemplate,
  verifiedNativeReleaseQualification,
} from "./release-native-acceptance.mts";
import { bindNativeQualificationLocators } from "./release-native-admission.mts";
import {
  discoverNativeQualificationLocators,
  createNativeCheckDiscoveryOperations,
} from "./release-native-check-discovery.mts";
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
  const observe = (page?: number) => {
    const kind = page === undefined ? "suites" : "checks";
    calls.push(kind);
    if (page === undefined) suiteReads++;
    const response =
      page === undefined
        ? { total_count: 1, check_suites: [structuredClone(suite)] }
        : {
            total_count: rows.length,
            check_runs: structuredClone(rows.slice((page - 1) * 100, page * 100)),
          };
    mutate?.(response, kind, suiteReads);
    return response;
  };
  const operations = {
    async suites() {
      return observe();
    },
    async checks(suiteId: number, page: number) {
      assert.equal(suiteId, 500);
      return observe(page);
    },
  };
  return {
    templates,
    prepared,
    rows,
    suite,
    operations,
    calls,
    setMutator(value: typeof mutate) {
      mutate = value;
    },
  };
}
const deadline = () => performance.now() + 120000;
void test("native discovery returns only unique inert exact stage/package locators and final expectation binding stays separate", async () => {
  const f = fixture();
  const locators = await discoverNativeQualificationLocators(f.templates, deadline(), {
    operations: f.operations,
  });
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
void test("native discovery refuses missing, false, wrong issuer and duplicate platform observations", async () => {
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
    await assert.rejects(() =>
      discoverNativeQualificationLocators(f.templates, deadline(), { operations: f.operations }),
    );
  }
});
void test("native discovery refuses changed expected inputs, incomplete capture and exact Check wire corruption", async () => {
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
    await assert.rejects(
      () => discoverNativeQualificationLocators(changed, deadline(), { operations: f.operations }),
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
    await assert.rejects(() =>
      discoverNativeQualificationLocators(f.templates, deadline(), { operations: f.operations }),
    );
  }
});
void test("native discovery requires complete stable pagination and brackets returned provider data", async () => {
  const f = fixture();
  const pending = Array.from({ length: 100 }, (_, index) => ({
    ...f.rows[0],
    id: 1000 + index,
    status: "in_progress",
  }));
  f.rows.unshift(...pending);
  assert.equal(
    (
      await discoverNativeQualificationLocators(f.templates, deadline(), {
        operations: f.operations,
      })
    ).length,
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
    await assert.rejects(() =>
      discoverNativeQualificationLocators(g.templates, deadline(), { operations: g.operations }),
    );
  }
});
void test("native discovery distinguishes selected report2 initial and predecessor branches and ignores other signed contexts", async () => {
  for (const initial of [false, true]) {
    const f = fixture("release-publication", initial);
    const pair = await discoverNativeQualificationLocators(f.templates, deadline(), {
      operations: f.operations,
    });
    assert.equal(pair.length, 2);
    const changed = structuredClone(f.templates);
    assert.ok(changed[0]!.journey);
    changed[0]!.journey.signed_context_sha256 = "0".repeat(64);
    await assert.rejects(
      () => discoverNativeQualificationLocators(changed, deadline(), { operations: f.operations }),
      /unique/,
    );
    const other = fixture("release-publication", !initial);
    f.rows.push({ ...other.rows[0], id: 503 });
    assert.equal(
      (
        await discoverNativeQualificationLocators(f.templates, deadline(), {
          operations: f.operations,
        })
      ).length,
      2,
    );
  }
});

void test("native discovery never extends an expired inherited role clock or performs a later provider read", async () => {
  const f = fixture();
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 20, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await discoverNativeQualificationLocators(f.templates, deadline(), {
        operations: f.operations,
      });
    }),
    /deadline/,
  );
  assert.equal(f.calls.length, 0);
  const g = fixture();
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 100, async () => {
      await discoverNativeQualificationLocators(g.templates, deadline(), {
        operations: {
          ...g.operations,
          async suites() {
            const body = await g.operations.suites();
            await new Promise((resolve) => setTimeout(resolve, 150));
            return body;
          },
        },
      });
    }),
    /deadline/,
  );
  assert.equal(g.calls.length, 1);
});

function sdkFetch(
  f: ReturnType<typeof fixture>,
  observe?: (url: URL, settings: RequestInit | undefined) => void,
): typeof globalThis.fetch {
  return async (input, settings) => {
    const url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    observe?.(url, settings);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(settings?.method, "GET");
    assert.equal(settings?.redirect, "manual");
    const body = url.pathname.endsWith("/check-suites")
      ? await f.operations.suites()
      : await f.operations.checks(
          Number(url.pathname.split("/").at(-2)),
          Number(url.searchParams.get("page")),
        );
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}
const sdkOptions = (f: ReturnType<typeof fixture>) => ({
  source: f.templates[0]!.candidate.source_commit,
  app: 900,
  deadline: deadline(),
  environment: { GH_TOKEN: "ghs_SYNTHETIC_READER_ONLY" },
});
void test("native discovery actual SDK fixes authority and captures the explicit reader before asynchronous work", async () => {
  const f = fixture();
  const environment = {
    GH_TOKEN: "ghs_SYNTHETIC_READER_ONLY",
    GH_HOST: "ambient.invalid",
    NODE_OPTIONS: "--ambient-hook",
  };
  const constructing = createNativeCheckDiscoveryOperations({
    ...sdkOptions(f),
    environment,
    fetch: sdkFetch(f, (url, settings) => {
      assert.equal(
        new Headers(settings?.headers).get("authorization"),
        "token ghs_SYNTHETIC_READER_ONLY",
      );
      assert.equal(new Headers(settings?.headers).get("x-github-api-version"), "2022-11-28");
      if (url.pathname.endsWith("/check-suites")) {
        assert.equal(
          url.pathname,
          `/repos/boburning/portcove/commits/${f.templates[0]!.candidate.source_commit}/check-suites`,
        );
        assert.equal(url.search, "?app_id=900&per_page=100&page=1");
      } else {
        assert.equal(url.pathname, "/repos/boburning/portcove/check-suites/500/check-runs");
        assert.equal(url.searchParams.get("filter"), "all");
        assert.equal(url.searchParams.get("per_page"), "100");
        assert.equal(url.searchParams.get("page"), "1");
        assert.equal(url.searchParams.get("check_name"), f.rows[0]!.name);
      }
    }),
  });
  environment.GH_TOKEN = "ghs_SYNTHETIC_OTHER_ROLE";
  const operations = await constructing;
  const locators = await discoverNativeQualificationLocators(f.templates, deadline(), {
    operations,
  });
  assert.equal(f.calls.length, 4);
  assert.equal(locators.length, 2);
  assert.ok(Object.isFrozen(locators) && locators.every(Object.isFrozen));
  await assert.rejects(
    createNativeCheckDiscoveryOperations({
      ...sdkOptions(f),
      environment: { GITHUB_TOKEN: "ghs_SYNTHETIC_WRONG_SOURCE" },
      fetch: sdkFetch(f),
    }),
    /explicit.*credential/,
  );
  await assert.rejects(
    () => discoverNativeQualificationLocators(f.templates, performance.now() - 1, { operations }),
    /deadline/,
  );
});

void test("native discovery actual SDK refuses non-200, failing streams, oversized bodies and redirects without replay", async () => {
  const f = fixture();
  for (const mode of ["created", "server", "stream", "oversized", "redirect"] as const) {
    let calls = 0;
    const operations = await createNativeCheckDiscoveryOperations({
      ...sdkOptions(f),
      fetch: async () => {
        calls++;
        if (mode === "stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.error(new Error("synthetic failed stream"));
              },
            }),
          );
        if (mode === "oversized") return new Response("x".repeat(8 * 1024 ** 2 + 1));
        if (mode === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.invalid/credential-target" },
          });
        return new Response("{}", {
          status: mode === "created" ? 201 : 503,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await assert.rejects(operations.suites());
    assert.equal(calls, 1, mode);
  }
});

void test("native discovery actual SDK preserves aggregate wire budget and original attempt allowance", async () => {
  const f = fixture();
  let calls = 0;
  const operations = await createNativeCheckDiscoveryOperations({
    ...sdkOptions(f),
    fetch: async () => {
      calls++;
      return new Response(`"${"x".repeat(8 * 1024 ** 2 - 2)}"`, {
        headers: { "content-type": "application/json" },
      });
    },
  });
  for (let index = 0; index < 4; index++) await operations.suites();
  await assert.rejects(operations.suites());
  assert.equal(calls, 5);
  let sends = 0;
  const bounded = await createNativeCheckDiscoveryOperations({
    ...sdkOptions(f),
    fetch: async () => {
      sends++;
      return new Response("{}");
    },
  });
  for (let index = 0; index < 40; index++) await bounded.suites();
  await assert.rejects(bounded.suites());
  assert.equal(sends, 40);
});

void test("native discovery actual SDK cancellation uses the inherited phase budget and drains the stream", async () => {
  const f = fixture();
  let calls = 0,
    cancelled = 0;
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 1000, async () => {
      const operations = await createNativeCheckDiscoveryOperations({
        ...sdkOptions(f),
        fetch: async () => {
          calls++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
          );
        },
      });
      await discoverNativeQualificationLocators(f.templates, deadline(), { operations });
    }),
    /deadline|cancel|time/u,
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

void test("native discovery preserves captured reader role and frozen template expectations across awaits", async (t) => {
  const f = fixture();
  const previous = process.env.GH_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  process.env.GH_TOKEN = "ghs_SYNTHETIC_CAPTURED_READER";
  await withReadOnlyReleaseChildren(process.cwd(), async () => {
    process.env.GH_TOKEN = "ghs_SYNTHETIC_OTHER_ROLE";
    const operations = await createNativeCheckDiscoveryOperations({
      source: f.templates[0]!.candidate.source_commit,
      app: 900,
      deadline: deadline(),
      fetch: sdkFetch(f, (_url, settings) =>
        assert.equal(
          new Headers(settings?.headers).get("authorization"),
          "token ghs_SYNTHETIC_CAPTURED_READER",
        ),
      ),
    });
    const result = await discoverNativeQualificationLocators(f.templates, deadline(), {
      operations: {
        ...operations,
        async suites() {
          f.templates[0]!.candidate.package.sha256 = "0".repeat(64);
          return operations.suites();
        },
      },
    });
    assert.equal(result.length, 2);
  });
});
