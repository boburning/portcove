/** Controlled whole-module executor behavior. Identity/provider dependencies
 * are inert mocks. Production creates every session; private maps stay private.
 * No hosted credential, provider request, signing or publication is performed. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import * as children from "node:child_process";
import childProcess from "node:child_process";
import * as identity from "../assembler-job-identity.mts";
import * as github from "../github-api.mts";
import * as journals from "../release-coordinator-journal-api.mts";
import * as state from "../release-coordinator-state.mts";
import * as remote from "../release-coordinator-remote.mts";
import * as operation from "../release-capacity-operation.mts";
import {
  inspectPublishedCatalogMetadata,
  inspectPublishedSite,
} from "../release-catalog-metadata-contract.mts";

type ExecutorModule = typeof import("../release-capacity-executor.mts");
type Subject = Pick<
  ExecutorModule,
  | "authenticateCapacityExecutor"
  | "recoverOwnedPublishedCatalogMetadata"
  | "recoverOwnedPublishedMetadata"
>;
interface ControlledDependencies {
  provider: (...args: unknown[]) => unknown;
  journalRequest: (...args: unknown[]) => unknown;
  journalGraphql: (...args: unknown[]) => unknown;
  snapshot: () => Promise<unknown>;
  recordCatalog: (...args: unknown[]) => Promise<unknown>;
  recordApplication: (...args: unknown[]) => Promise<unknown>;
}
let active: ControlledDependencies | undefined;
function controls() {
  assert.ok(active);
  return active;
}
const forbidden = () => {
  throw new Error("Uncontrolled process/provider work is forbidden");
};
globalThis.fetch = forbidden;
process.kill = forbidden;
// Constrain already-loaded dependency bindings as well as fresh module imports.
for (const [name, value] of Object.entries(childProcess))
  if (typeof value === "function") Reflect.set(childProcess, name, forbidden);
syncBuiltinESMExports();
const safeChildren = Object.fromEntries(
  Object.entries(children)
    .filter(([name]) => name !== "default")
    .map(([name, value]) => [name, typeof value === "function" ? forbidden : value]),
);
mock.module("node:child_process", { namedExports: safeChildren, defaultExport: safeChildren });
const expected = {
  audience: "portcove-capacity-executor",
  subject: "repo:boburning@43177418/portcove@1354613114:environment:production-release-coordinator",
  controller_revision: "a".repeat(40),
  controller_ref: "refs/tags/portcove-production-controller-fixture",
  actor_id: "1122",
  run_id: "124",
  run_attempt: 1,
};
mock.module(new URL("../assembler-job-identity.mts", import.meta.url).href, {
  namedExports: {
    ...identity,
    requestAssemblerToken: async (audience: string) => {
      assert.equal(audience, expected.audience);
      return "inert-provider-identity";
    },
    verifyCapacityExecutorJobIdentity: async (role: string, token: string, actual: unknown) => {
      assert.equal(role, "coordinator");
      assert.equal(token, "inert-provider-identity");
      assert.deepEqual(actual, expected);
      return {
        evidence_scope: "github.com",
        workflow_revision: expected.controller_revision,
        execution_ref: expected.controller_ref,
        workflow: ".github/workflows/fixture.yml",
        run_id: expected.run_id,
        run_attempt: 1,
        job_id: 45,
        check_run_id: "46",
        actor_id: expected.actor_id,
        role,
      };
    },
  },
});
mock.module(new URL("../github-api.mts", import.meta.url).href, {
  namedExports: {
    ...github,
    createGitHubRunner: forbidden,
    GitHubApiClient: class {
      request(...args: unknown[]) {
        return controls().provider(...args);
      }
    },
  },
});
mock.module(new URL("../release-coordinator-journal-api.mts", import.meta.url).href, {
  namedExports: {
    ...journals,
    createCoordinatorJournalApi: () => ({
      request: (...args: unknown[]) => controls().journalRequest(...args),
      graphql: (...args: unknown[]) => controls().journalGraphql(...args),
    }),
  },
});
mock.module(new URL("../release-coordinator-state.mts", import.meta.url).href, {
  namedExports: { ...state, recoverReleaseOpportunity: () => controls().snapshot() },
});
mock.module(new URL("../release-coordinator-remote.mts", import.meta.url).href, {
  namedExports: { ...remote, publishCoordinatorCheckpoint: async () => ({}) },
});
mock.module(new URL("../release-capacity-operation.mts", import.meta.url).href, {
  namedExports: {
    ...operation,
    recordPublishedCatalogMetadata: (...args: unknown[]) => controls().recordCatalog(...args),
    recordPublishedApplicationSiteMetadata: (...args: unknown[]) =>
      controls().recordApplication(...args),
  },
});
const entry = new URL("../release-capacity-executor.mts", import.meta.url);
const alias = new URL(entry);
alias.searchParams.set("fixture-export-alias", "true");
registerHooks({
  load(url, context, next) {
    if (url !== alias.href) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
    import {authenticateCapacityExecutor as actualAuthentication, recoverOwnedPublishedCatalogMetadata as actualCatalog, recoverOwnedPublishedMetadata as actualApplication} from ${JSON.stringify(entry.href)};
    export {actualAuthentication as authenticateCapacityExecutor, actualCatalog as recoverOwnedPublishedCatalogMetadata, actualApplication as recoverOwnedPublishedMetadata};
  `,
    };
  },
});

async function sharedRecovery(subject: Subject, omitGuard = false, journalMode = false) {
  const original = {
    role: "site-publication",
    run_id: "123",
    job_id: 42,
    run_attempt: 1,
    controller_revision: "b".repeat(40),
    execution_ref: "refs/tags/fixture",
    check_run_id: "43",
    actor_id: "44",
    workflow: ".github/workflows/fixture.yml",
  };
  const publication = {
    evidence_sha256: "a".repeat(64),
    remote_identity: `github-pages:boburning/portcove:${"b".repeat(64)}`,
  };
  const metadata = {
    schema_version: 1,
    root_sha256: "1".repeat(64),
    offline_targets_sha256: "2".repeat(64),
    index_sha256: "3".repeat(64),
    repository_sha256: "4".repeat(64),
    verifier_repository_sha256: "5".repeat(64),
    timestamp_sha256: "6".repeat(64),
    snapshot_sha256: "7".repeat(64),
    immutable_targets_sha256: "8".repeat(64),
    versions: { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" },
    expires: Object.fromEntries(
      ["targets", "definitions", "policy", "snapshot", "timestamp"].map((role) => [
        role,
        "2026-12-01T00:00:00Z",
      ]),
    ),
    source_commit: "c".repeat(40),
    source_tree: "d".repeat(40),
    operation_id: "e".repeat(64),
    publication: { ...publication, site_generation_sha256: "b".repeat(64) },
  };
  const site = {
    schema_version: 1,
    generation_sha256: "b".repeat(64),
    components: {
      application: null,
      catalog: { root_sha256: metadata.root_sha256, repository_sha256: metadata.repository_sha256 },
    },
    operation_id: metadata.operation_id,
    publication,
  };
  const op = {
    id: metadata.operation_id,
    kind: "upload",
    destination: "github-pages:boburning/portcove:complete-site",
    outcome: "recovered",
    recovery: { resolution: "effect-completed" },
    completed_effects: [publication],
    catalog_publication: { authority: "none" },
    executor_identity: original,
  };
  let journalWrites = 0;
  let jobStatus = "completed",
    reads = 0,
    catalogWrites = 0,
    appWrites = 0,
    callbackReads = 0;
  const api = {
    request(method: string) {
      if (method !== "GET") {
        journalWrites++;
        return { status: 201, body: {} };
      }
      reads++;
      return {
        status: 200,
        body: {
          id: 42,
          run_id: 123,
          run_attempt: 1,
          head_sha: original.controller_revision,
          status: jobStatus,
          conclusion: "success",
          check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/43",
        },
      };
    },
  };

  active = {
    provider: (...args) => {
      const method = args[0];
      assert.ok(typeof method === "string");
      return api.request(method);
    },
    journalRequest: (...args) => {
      const method = args[0];
      assert.ok(typeof method === "string");
      return api.request(method);
    },
    journalGraphql: forbidden,
    snapshot: async () => ({ input: { controller: { capacity_attempt: { operation: op } } } }),
    recordCatalog: async (...args) => {
      const actual = args[2],
        cursor = args[3],
        options = args[4];
      assert.ok(options && typeof options === "object");
      const remote: unknown = Reflect.get(options, "remote");
      assert.ok(remote && typeof remote === "object");
      const journal: unknown = Reflect.get(remote, "api");
      assert.ok(journal && typeof journal === "object");
      const request: unknown = Reflect.get(journal, "request");
      assert.ok(typeof request === "function");
      Reflect.apply(request, journal, ["POST", "repos/boburning/portcove/git/blobs", {}]);
      catalogWrites++;
      assert.deepEqual(actual, inspectPublishedCatalogMetadata(metadata));
      assert.deepEqual(cursor, inspectPublishedSite(site));
      return { checkpoint: "advanced", durable_checkpoint: "advanced" };
    },
    recordApplication: async () => {
      appWrites++;
      throw new Error("wrong component");
    },
  };
  const runRecovery = async (
    raw: { repository: string; checkpoint: string; remote_configuration: unknown },
    readback: () => Promise<unknown>,
    component: "application" | "catalog" = "application",
    beforeMutation?: () => unknown,
  ) => {
    const session = await subject.authenticateCapacityExecutor("coordinator", expected, "inert");
    const guard = omitGuard ? undefined : beforeMutation;
    return component === "catalog"
      ? subject.recoverOwnedPublishedCatalogMetadata(session, raw, readback, guard)
      : subject.recoverOwnedPublishedMetadata(session, raw, readback, guard);
  };
  const raw = { repository: "inert", checkpoint: "old", remote_configuration: {} };
  const readback = async () => {
    callbackReads++;
    return { metadata, site };
  };
  if (journalMode) {
    let writes = 0,
      journalReads = 0,
      stale = false;
    const inspectJournal = (args: unknown[]) => {
      const options = args[4];
      assert.ok(options && typeof options === "object");
      const retainedRemote: unknown = Reflect.get(options, "remote");
      assert.ok(retainedRemote && typeof retainedRemote === "object");
      const journal: unknown = Reflect.get(retainedRemote, "api");
      assert.ok(journal && typeof journal === "object");
      const request: unknown = Reflect.get(journal, "request"),
        graphql: unknown = Reflect.get(journal, "graphql");
      assert.equal(typeof request, "function");
      assert.equal(typeof graphql, "function");
      return {
        request: (...values: unknown[]) =>
          Reflect.apply(request as (...values: unknown[]) => unknown, journal, values),
        graphql: (...values: unknown[]) =>
          Reflect.apply(graphql as (...values: unknown[]) => unknown, journal, values),
      };
    };
    assert.ok(active);
    active.journalRequest = (method) => {
      if (method === "GET") journalReads++;
      else writes++;
    };
    active.journalGraphql = (query) => {
      assert.equal(typeof query, "string");
      if (/^\s*mutation\b/u.test(String(query))) writes++;
      else journalReads++;
    };
    active.recordCatalog = async (...args) => {
      const journal = inspectJournal(args);
      journal.request("POST");
      journal.graphql("mutation { exactCAS }");
      assert.equal(writes, 2);
      stale = true;
      journal.request("GET");
      journal.graphql("query { readback }");
      assert.equal(journalReads, 2);
      assert.throws(
        () => journal.request("POST"),
        /controls stale/,
        "JOURNAL_GUARD_REST must reject a stale mutation",
      );
      assert.throws(
        () => journal.graphql("mutation { exactCAS }"),
        /controls stale/,
        "JOURNAL_GUARD_GRAPHQL must reject a stale mutation",
      );
      return { checkpoint: "advanced", durable_checkpoint: "advanced" };
    };
    await runRecovery(raw, readback, "catalog", () => {
      if (stale) throw new Error("controls stale");
    });
    active.recordCatalog = async (...args) => {
      inspectJournal(args).request("POST");
      return { checkpoint: "advanced", durable_checkpoint: "advanced" };
    };
    await assert.rejects(
      runRecovery(raw, readback, "catalog", () => Promise.resolve()),
      /complete synchronously/,
      "JOURNAL_GUARD_ASYNC must reject an asynchronous guard",
    );
    assert.equal(writes, 2);
    return;
  }
  assert.equal((await runRecovery(raw, readback, "catalog")).checkpoint, "advanced");
  assert.equal(reads, 2, "CATALOG_EXECUTOR_CALLER must execute the consumed recovery export");
  assert.equal(callbackReads, 1);
  assert.equal(catalogWrites, 1);
  assert.equal(appWrites, 0);
  await assert.rejects(runRecovery(raw, readback), /different component/);
  jobStatus = "in_progress";
  await assert.rejects(runRecovery(raw, readback, "catalog"), /not observed terminal/);
  assert.equal(callbackReads, 1);
  assert.equal(catalogWrites, 1);
  jobStatus = "completed";
  await assert.rejects(
    runRecovery(
      raw,
      async () => ({ metadata, site: { ...site, generation_sha256: "f".repeat(64) } }),
      "catalog",
    ),
    /cursor differs/,
  );
  assert.equal(catalogWrites, 1);
  let clock = 59000;
  const beforeMutation = () => {
    if (clock >= 60000) throw new Error("fresh controls expired before actual journal mutation");
  };
  await assert.rejects(
    runRecovery(
      raw,
      async () => {
        clock = 61000;
        return { metadata, site };
      },
      "catalog",
      beforeMutation,
    ),
    /fresh controls expired/,
    "CATALOG_RECOVERY_GUARD original controls must reject before journal mutation",
  );
  assert.equal(journalWrites, 1, "slow readback cannot reach the subsequent journal mutation");
  assert.equal(catalogWrites, 1);
}

function checkedSubject(value: unknown): Subject {
  assert.ok(value && typeof value === "object");
  for (const name of [
    "authenticateCapacityExecutor",
    "recoverOwnedPublishedCatalogMetadata",
    "recoverOwnedPublishedMetadata",
  ])
    assert.equal(typeof Reflect.get(value, name), "function");
  return value as Subject;
}
const subject = checkedSubject(await import(entry.href));
const aliased = checkedSubject(await import(alias.href));
const mode = process.argv[2];
assert.ok(mode === "catalog-recovery" || mode === "journal-controls");
const journalMode = mode === "journal-controls";
await sharedRecovery(subject, false, journalMode);
await sharedRecovery(aliased, false, journalMode);
await assert.rejects(
  sharedRecovery(subject, true, journalMode),
  journalMode ? /JOURNAL_GUARD_REST/ : /CATALOG_RECOVERY_GUARD/,
);
const replaced: Subject = {
  ...subject,
  recoverOwnedPublishedCatalogMetadata: async () => ({
    checkpoint: "advanced",
    operation_id: "e".repeat(64),
    site_generation_sha256: "b".repeat(64),
  }),
};
await assert.rejects(
  sharedRecovery(replaced, false, journalMode),
  journalMode ? /JOURNAL_GUARD_ASYNC/ : /CATALOG_EXECUTOR_CALLER/,
);
console.log(mode + " PASS; controlled dependencies, no hosted authority");
