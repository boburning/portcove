import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { productionControllerWorkflow } from "../production-controller-admission.mts";
import { controllerOidcSubject } from "../assembler-job-identity.mts";

// Disposable in-memory test signing key. No production key or token is used.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
export const expected = {
  audience: "portcove-trusted-assembly",
  subject: controllerOidcSubject("refs/tags/portcove-production-controller-fixture"),
  controller_revision: "a".repeat(40),
  controller_ref: "refs/tags/portcove-production-controller-fixture",
  actor_id: "1122",
  run_id: "9988",
  run_attempt: 2,
};

export function assemblerIdentityFixture(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  profile = { workflow: productionControllerWorkflow, job: "Trusted package assembly" },
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: expected.audience,
    sub: expected.subject,
    exp: now + 300,
    nbf: now - 2,
    iat: now - 2,
    repository: "boburning/portcove",
    repository_id: "1354613114",
    repository_owner: "boburning",
    repository_owner_id: "43177418",
    actor_id: expected.actor_id,
    ref: expected.controller_ref,
    ref_type: "tag",
    sha: expected.controller_revision,
    workflow_sha: expected.controller_revision,
    workflow_ref: `boburning/portcove/${profile.workflow}@${expected.controller_ref}`,
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    run_id: expected.run_id,
    run_attempt: "2",
    check_run_id: "777",
    ...overrides,
  };
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fixture", ...headerOverrides })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const faults = { value: "" };
  let requests = 0;
  let keyReads = 0;
  let runReads = 0;
  const readKeys = async () => {
    keyReads++;
    return { keys: faults.value === "keys" ? [jwk, jwk] : [jwk] };
  };
  const job = (id: number) => ({
    id,
    run_id: 9988,
    run_attempt: 2,
    head_sha: expected.controller_revision,
    status: "completed",
    name: "Other job",
    check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${1000 + id}`,
  });
  const transport = {
    cwd: process.cwd(),
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => {
      assert.equal(command, "gh");
      assert.deepEqual(args.slice(-4), ["--method", "GET", "--hostname", "github.com"]);
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.equal(options.timeout, 15_000);
      assert.equal(options.input, undefined);
      requests++;
      const endpoint = args[2]!;
      let body: unknown;
      if (endpoint.endsWith("/actions/runs/9988")) {
        runReads++;
        body = {
          id: 9988,
          run_attempt: faults.value === "attempt" ? 3 : 2,
          head_sha:
            faults.value === "drift" && runReads > 1
              ? "b".repeat(40)
              : expected.controller_revision,
          path: profile.workflow,
          event: "workflow_dispatch",
          status: "in_progress",
          repository: { id: 1354613114, full_name: "boburning/portcove" },
          head_repository: { id: 1354613114 },
        };
      } else if (endpoint.endsWith("/actions/jobs/501")) {
        body = {
          ...job(501),
          status: faults.value === "job-completed" ? "completed" : "in_progress",
          name: profile.job,
          check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
        };
      } else {
        assert.ok(endpoint.includes("/attempts/2/jobs?per_page=100&page="));
        const second = endpoint.endsWith("page=2");
        const selected = {
          ...job(faults.value === "duplicate" ? 1 : 501),
          head_sha: faults.value === "job-source" ? "b".repeat(40) : expected.controller_revision,
          status: "in_progress",
          name: profile.job,
          check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${faults.value === "name-only" ? "778" : "777"}`,
        };
        body = {
          total_count: faults.value === "count" && second ? 102 : 101,
          jobs: second
            ? faults.value === "missing"
              ? []
              : [selected]
            : Array.from({ length: 100 }, (_, index) => job(index + 1)),
        };
      }
      return {
        status: 0,
        stdout: `HTTP/2.0 ${faults.value === "api-status" ? 503 : 200} Fixture\r\nContent-Type: application/json\r\n\r\n${faults.value === "api-json" ? "{malformed" : JSON.stringify(body)}`,
        stderr: "",
      };
    },
  };
  return { token, faults, readKeys, transport, counts: () => ({ requests, keyReads }) };
}
