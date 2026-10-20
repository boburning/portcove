/** Fixed local native issuer continuation. Imported reports, transport clients,
 * caller success flags and source-reader tokens cannot appoint this writer. */
import { execFileSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  prepareSemanticAppJwt,
  inspectSemanticInstallationToken,
} from "./release-semantic-issuer.mts";
import { inspectSemanticIssuerRequest } from "./release-semantic-issuer-http.mts";
import { prepareNativeQualificationCheck } from "./release-native-acceptance.mts";
import { requireActualNativePreSignReport } from "./release-native-pre-sign-report.mts";
import { reconcileActualNativeCheck } from "./release-native-candidate.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";

const repository = "repos/boburning/portcove";
type Issuer = { app_id: number; installation_id: number };

/** Provider response integrity only. Appointment comes exclusively from the
 * private installed parent and its independently pinned global configuration. */
export function inspectNativeIssuerBoundary(raw: unknown, expected: Issuer) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "app,installation,repositories,repository"
  )
    throw new Error("native issuer provider read inventory differs");
  const app = raw.app,
    installation = raw.installation,
    repositories = raw.repositories,
    repo = raw.repository;
  if (
    !Number.isSafeInteger(expected.app_id) ||
    expected.app_id < 1 ||
    !Number.isSafeInteger(expected.installation_id) ||
    expected.installation_id < 1 ||
    !isRecord(app) ||
    app.id !== expected.app_id ||
    !isRecord(installation) ||
    installation.id !== expected.installation_id ||
    installation.app_id !== expected.app_id ||
    !isRecord(installation.account) ||
    installation.account.id !== 43177418 ||
    installation.account.login !== "boburning" ||
    installation.suspended_at !== null ||
    installation.repository_selection !== "selected" ||
    digest(installation.permissions) !== digest({ checks: "write", metadata: "read" }) ||
    !isRecord(repositories) ||
    repositories.total_count !== 1 ||
    !Array.isArray(repositories.repositories) ||
    repositories.repositories.length !== 1 ||
    !isRecord(repositories.repositories[0]) ||
    repositories.repositories[0].id !== 1354613114 ||
    repositories.repositories[0].full_name !== "boburning/portcove" ||
    !isRecord(repo) ||
    repo.id !== 1354613114 ||
    repo.full_name !== "boburning/portcove"
  )
    throw new Error("native App/installation/repository/permission boundary differs");
  const readback = {
    app: { id: app.id },
    installation: {
      id: installation.id,
      app_id: installation.app_id,
      account: { id: installation.account.id, login: installation.account.login },
      suspended_at: installation.suspended_at,
      repository_selection: installation.repository_selection,
      permissions: { checks: "write", metadata: "read" },
    },
    repositories: {
      total_count: 1,
      repositories: [{ id: 1354613114, full_name: "boburning/portcove" }],
    },
    repository: { id: repo.id, full_name: repo.full_name },
  };
  return Object.freeze({
    issuer: Object.freeze({ ...expected }),
    repository_id: 1354613114,
    observed_sha256: digest(readback),
    readback,
    authority: "none" as const,
  });
}

/** Strict finite append-only attempt readback. A truncated line remains
 * ambiguous; only an original durable pre-POST marker permits absence of a
 * Check write. This function cannot authorize repeating an invocation. */
export function inspectNativeCheckAttempt(
  raw: unknown,
  expected: { invocation_id: string; body_sha256: string },
) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768 || !raw.endsWith("\n"))
    throw new Error("native Check attempt is missing, truncated or unbounded");
  const records: Record<string, unknown>[] = raw
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !== "body_sha256,invocation_id,phase,schema_version" ||
        value.schema_version !== 1 ||
        value.invocation_id !== expected.invocation_id ||
        value.body_sha256 !== expected.body_sha256
      )
        throw new Error("native Check attempt identity differs");
      return value;
    });
  const phases = records.map((value) => value.phase);
  if (
    phases.length < 1 ||
    phases.length > 3 ||
    phases[0] !== "prepared" ||
    (phases.length > 1 && phases[1] !== "post-started") ||
    (phases.length > 2 && phases[2] !== "readback-completed")
  )
    throw new Error("native Check attempt phase is contradictory");
  return Object.freeze({
    post_attempted: phases.length >= 2,
    readback_completed: phases.length === 3,
    authority: "none" as const,
  });
}

const issuing = new WeakSet<object>();
/** No injected transport. All credentials travel through the fixed Node HTTP
 * worker's private stdin, after actual source/capture/teardown revalidation. */
export async function publishActualNativePreSignReport(receipt: object) {
  if (issuing.has(receipt)) throw new Error("native report handoff is already in progress");
  issuing.add(receipt);
  let token = "",
    jwt = "";
  try {
    let actual = await requireActualNativePreSignReport(receipt);
    const wire = prepareNativeQualificationCheck(actual.report);
    const configuration = actual.parent.authority_configuration;
    const issuer = configuration.apps.native_qualification;
    const custody = actual.parent.transport_configuration.native_issuer;
    const directory = actual.capture_directory;
    // CreateNew prevents reusing this report or resetting a failed attempt.
    await writeFile(path.join(directory, "expected-check.json"), JSON.stringify(wire), {
      flag: "wx",
      mode: 0o600,
    });
    const log = await open(path.join(directory, "check-attempt.jsonl"), "wx", 0o600);
    const append = async (phase: string) => {
      await log.writeFile(
        JSON.stringify({
          schema_version: 1,
          invocation_id: actual.request.request.invocation_id,
          body_sha256: digest(wire.body),
          phase,
        }) + "\n",
      );
      await log.sync();
    };
    try {
      await append("prepared");
      // The private parent getter positively rechecks the issuer file's
      // appointed Windows ACL / Linux owner custody before this read.
      await actual.parent.recheck();
      const key = await readBoundedPublicBuildInputFile(
        path.dirname(custody.private_key),
        path.basename(custody.private_key),
        16 * 1024,
      );
      try {
        jwt = prepareSemanticAppJwt(
          key,
          issuer.app_id,
          custody.public_key_sha256,
          Math.floor(Date.now() / 1000),
        );
      } finally {
        key.fill(0);
      }
      const started = Date.now();
      let requests = 0;
      const worker = path.join(
        actual.parent.controller_root,
        "scripts/release-semantic-issuer-http.mts",
      );
      const workerConfiguration = {
        app_id: issuer.app_id,
        installation_id: issuer.installation_id,
        head: wire.body.head_sha,
        check_body_sha256: digest(wire.body),
      };
      const request = async (
        kind: "app" | "installation",
        method: "GET" | "POST",
        endpoint: string,
        body: unknown = null,
      ) => {
        await actual.parent.recheck();
        if (++requests > 12 || Date.now() - started > 120000)
          throw new Error("native issuer credential session exhausted");
        const transport = {
          kind,
          token: kind === "app" ? jwt : token,
          configuration: workerConfiguration,
          method,
          endpoint,
          body,
        };
        inspectSemanticIssuerRequest(transport);
        let value: unknown;
        try {
          const output = execFileSync(process.execPath, [worker], {
            input: JSON.stringify(transport),
            encoding: "utf8",
            timeout: Math.min(12000, 120000 - (Date.now() - started)),
            maxBuffer: 3 * 1024 * 1024,
            windowsHide: true,
            env: { LANG: "C.UTF-8" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          value = JSON.parse(output);
        } catch {
          throw new Error(
            "native issuer request failed; retain original attempt and reconcile before any later action",
          );
        }
        if (
          !isRecord(value) ||
          !Number.isSafeInteger(value.status) ||
          !Array.isArray(value.headers) ||
          Date.now() - started > 120000
        )
          throw new Error("native issuer response incomplete or late");
        await actual.parent.recheck();
        return value;
      };
      const get = async (kind: "app" | "installation", endpoint: string) => {
        const result = await request(kind, "GET", endpoint);
        if (result.status !== 200) throw new Error("native issuer provider read unavailable");
        return result.body;
      };
      const app = await get("app", "app"),
        installation = await get("app", `app/installations/${issuer.installation_id}`);
      const minted = await request(
        "app",
        "POST",
        `app/installations/${issuer.installation_id}/access_tokens`,
        { repository_ids: [1354613114], permissions: { checks: "write", metadata: "read" } },
      );
      token = inspectSemanticInstallationToken(Number(minted.status), minted.body, Date.now());
      jwt = "";
      const repositories = await get("installation", "installation/repositories?per_page=100"),
        repo = await get("installation", repository);
      const observed = inspectNativeIssuerBoundary(
        { app, installation, repositories, repository: repo },
        issuer,
      );
      await writeFile(path.join(directory, "issuer-observation.json"), JSON.stringify(observed), {
        flag: "wx",
        mode: 0o600,
      });
      actual = await requireActualNativePreSignReport(receipt);
      if (digest(prepareNativeQualificationCheck(actual.report).body) !== digest(wire.body))
        throw new Error("native report changed before Check handoff");
      // The sole mutating Check request is latched durably BEFORE invoking
      // HTTP. Refusal, timeout or lost response can never trigger a retry.
      await append("post-started");
      const response = await request("installation", "POST", `${repository}/check-runs`, wire.body);
      await writeFile(
        path.join(directory, "check-post-response.json"),
        JSON.stringify({ status: response.status, body_sha256: digest(response.body) }),
        { flag: "wx", mode: 0o600 },
      );
      if (response.status !== 201)
        throw new Error("native Check POST refused or ambiguous; readback required");
      const readback = await reconcileActualNativeCheck(
        actual.source_selection,
        actual.request,
        wire,
      );
      await writeFile(path.join(directory, "check-readback.json"), JSON.stringify(readback), {
        flag: "wx",
        mode: 0o600,
      });
      await append("readback-completed");
      return Object.freeze({
        decision: "persisted" as const,
        report_sha256: actual.report_sha256,
        observation_sha256: digest(observed),
        readback,
        authority: "none" as const,
        scope:
          "direct native report persisted; independently authenticated acceptance consumer required",
      });
    } finally {
      await log.close();
    }
  } finally {
    token = "";
    jwt = "";
    issuing.delete(receipt);
  }
}
