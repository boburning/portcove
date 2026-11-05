/** Setup-only observation of the complete installation selection. A token
 * explicitly narrowed to one repository cannot supply this evidence. */
import { performance } from "node:perf_hooks";
import { prepareSemanticAppJwt } from "./release-semantic-issuer.mts";
import {
  inspectHostedReleaseAppIdentity,
  type HostedReleaseAppRole,
} from "./release-hosted-app-setup.mts";
import type { AppRegistrationStore } from "./release-app-registration-capture.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

const origin = "https://api.github.com";
const maximumBody = 64 * 1024;

/** The caller supplies the selected role's private key and a fresh durable
 * private store. No CLI/default credential, installation grant or remote write
 * beyond one metadata-only token mint is supplied. Refusal never retries it. */
export async function observeHostedAppInstallationScope(
  role: HostedReleaseAppRole,
  key: Buffer,
  expected: { app_id: number; public_key_sha256: string },
  store: AppRegistrationStore,
  options: { fetch?: typeof fetch } = {},
) {
  const started = performance.now();
  const jwt = prepareSemanticAppJwt(
    key,
    expected.app_id,
    expected.public_key_sha256,
    Math.floor(Date.now() / 1000),
  );
  // Validate the closed role before storage or any network operation.
  if (role !== "semantic" && role !== "protection_observer" && role !== "storage_writer")
    throw new Error("unselected hosted App role");
  const active = (cleanup = false) => {
    const budget = role === "storage_writer" && !cleanup ? 90000 : 120000;
    const remaining = Math.floor(budget - (performance.now() - started));
    if (remaining < 1) throw new Error("installation observation deadline exhausted");
    return Math.min(10000, remaining);
  };
  let requests = 0;
  const request = async (
    name: string,
    endpoint: string,
    bearer: string,
    payload?: { permissions: { metadata: "read" } },
    cleanup?: "DELETE",
  ): Promise<unknown> => {
    if (cleanup && (role !== "storage_writer" || endpoint !== "/installation/token" || payload))
      throw new Error("installation cleanup route differs");
    if (++requests > (role === "storage_writer" ? 9 : 8))
      throw new Error("installation observation request bound exhausted");
    const timeout = active(cleanup !== undefined);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${origin}${endpoint}`, {
        method: cleanup ?? (payload ? "POST" : "GET"),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bearer}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      await store.write(
        `${name}.json`,
        Buffer.from(
          JSON.stringify({
            effect: payload || cleanup ? "unknown" : "read-unavailable",
            retry: "forbidden",
          }),
        ),
      );
      throw new Error("installation observation transport unavailable; retain original attempt");
    }
    if (cleanup) {
      await response.body?.cancel();
      await store.write(
        `${name}.json`,
        Buffer.from(
          JSON.stringify({
            method: cleanup,
            status: response.status,
            revoked: response.status === 204,
            automatic_retry: false,
          }),
        ),
      );
      active(true);
      if (response.status !== 204)
        throw new Error("metadata installation token revocation not acknowledged");
      return { revoked: true };
    }
    const chunks: Buffer[] = [];
    let length = 0,
      complete = false;
    const reader = response.body?.getReader();
    try {
      if (!reader) throw new Error("installation response body unavailable");
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          complete = true;
          break;
        }
        const chunk: unknown = part.value;
        if (!(chunk instanceof Uint8Array))
          throw new Error("installation response is not byte data");
        const kept = chunk.subarray(0, maximumBody - length);
        chunks.push(Buffer.from(kept));
        length += kept.length;
        if (kept.length !== chunk.length) break;
        active();
      }
    } catch {
      // Preserve the available prefix before rejecting this response.
    } finally {
      if (!complete) await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      const raw = Buffer.concat(chunks);
      let retained = raw;
      if (role === "storage_writer" && name === "token-response") {
        let projection: unknown = { unparsed: true, observed_bytes: raw.length };
        try {
          const value: unknown = JSON.parse(raw.toString("utf8"));
          if (isRecord(value))
            projection = {
              expires_at: value.expires_at,
              permissions: value.permissions,
              token: "omitted",
            };
        } catch {
          /* Do not retain a partial secret-bearing token response. */
        }
        retained = Buffer.from(JSON.stringify(projection));
      }
      await store.write(
        `${name}.json`,
        Buffer.from(
          JSON.stringify({
            status: response.status,
            complete,
            link: response.headers.get("link"),
            body_base64: retained.toString("base64"),
            ...(retained === raw ? {} : { encoding: "metadata-token-omitted" }),
          }),
        ),
      );
    }
    active();
    if (!complete || response.status !== (payload ? 201 : 200) || response.headers.has("link"))
      throw new Error("installation observation incomplete, paginated or refused");
    const bytes = Buffer.concat(chunks);
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
      throw new Error("installation response text differs");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  const app = await request("app", "/app", jwt);
  const identity = inspectHostedReleaseAppIdentity(role, expected.app_id, app);
  const installations = await request("installations", "/app/installations?per_page=100", jwt);
  if (!Array.isArray(installations) || installations.length !== 1)
    throw new Error("exactly one selected installation required");
  const inspectInstallation = (value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      value.app_id !== expected.app_id ||
      !isRecord(value.account) ||
      value.account.id !== 43177418 ||
      value.account.login !== "boburning" ||
      value.repository_selection !== "selected" ||
      value.suspended_at !== null ||
      releaseCanonicalDigest(value.permissions) !== releaseCanonicalDigest(identity.permissions) ||
      !Array.isArray(value.events) ||
      value.events.length !== 0
    )
      throw new Error("installation owner, permissions or selection differs");
    return {
      id: value.id,
      updated_at: value.updated_at,
      app_id: value.app_id,
      account: { id: value.account.id, login: value.account.login },
      repository_selection: value.repository_selection,
      suspended_at: value.suspended_at,
      permissions: value.permissions,
      events: value.events,
    };
  };
  const selected = inspectInstallation(installations[0]);
  const endpoint = `/app/installations/${selected.id}`;
  const before = inspectInstallation(await request("installation-before", endpoint, jwt));
  if (releaseCanonicalDigest(before) !== releaseCanonicalDigest(selected))
    throw new Error("installation changed during discovery");
  // Repository filters are intentionally absent: the provider contract then
  // grants this metadata-only token the full installation repository set.
  const payload = { permissions: { metadata: "read" as const } };
  await store.write(
    "token-intent.json",
    Buffer.from(
      JSON.stringify({
        installation_id: selected.id,
        method: "POST",
        endpoint: `${endpoint}/access_tokens`,
        body: payload,
        repository_filter: "omitted-full-installation",
        effect: "pending",
        automatic_retry: false,
      }),
    ),
  );
  const minted = await request("token-response", `${endpoint}/access_tokens`, jwt, payload);
  if (
    !isRecord(minted) ||
    typeof minted.token !== "string" ||
    !minted.token ||
    minted.token.length > 16384 ||
    /[\r\n\0]/u.test(minted.token)
  )
    throw new Error("metadata-only installation token unavailable or unexpected");
  const token = minted.token;
  let originalFailure: { error: unknown } | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  const result = await (async () => {
    try {
      if (
        !isRecord(minted) ||
        typeof minted.token !== "string" ||
        !minted.token ||
        minted.token.length > 16384 ||
        releaseCanonicalDigest(minted.permissions) !==
          releaseCanonicalDigest(payload.permissions) ||
        typeof minted.expires_at !== "string" ||
        !Number.isFinite(Date.parse(minted.expires_at)) ||
        Date.parse(minted.expires_at) <= Date.now() + 60000 ||
        Date.parse(minted.expires_at) > Date.now() + 3900000
      )
        throw new Error("metadata-only installation token unavailable or unexpected");
      const inspectRepositories = (value: unknown) => {
        if (
          !isRecord(value) ||
          value.total_count !== 1 ||
          !Array.isArray(value.repositories) ||
          value.repositories.length !== 1 ||
          !isRecord(value.repositories[0]) ||
          value.repositories[0].id !== 1354613114 ||
          value.repositories[0].full_name !== "boburning/portcove"
        )
          throw new Error("full installation must select exactly boburning/portcove");
        return { total_count: 1, repository_id: 1354613114, repository: "boburning/portcove" };
      };
      const repositories = inspectRepositories(
        await request(
          "repositories-before",
          "/installation/repositories?per_page=100",
          minted.token,
        ),
      );
      const after = inspectInstallation(await request("installation-after", endpoint, jwt));
      const refreshed = inspectRepositories(
        await request(
          "repositories-after",
          "/installation/repositories?per_page=100",
          minted.token,
        ),
      );
      if (
        releaseCanonicalDigest(before) !== releaseCanonicalDigest(after) ||
        releaseCanonicalDigest(repositories) !== releaseCanonicalDigest(refreshed)
      )
        throw new Error("installation selection changed during observation");
      inspectHostedReleaseAppIdentity(
        role,
        expected.app_id,
        await request("app-after", "/app", jwt),
      );
      const result = {
        ...identity,
        installation_id: selected.id,
        public_key_sha256: expected.public_key_sha256,
        ...repositories,
        installation_repository_scope: "full-installation-observed",
        evidence_scope: options.fetch ? "injected-provider" : "github.com",
        observed_at: new Date().toISOString(),
        token_expires_at: minted.expires_at,
        api_requests: requests,
        acceptance: "not-established",
        authority: "none",
        automatic_retry: false,
      };
      return result;
    } catch (error) {
      originalFailure = { error };
      return null;
    } finally {
      if (role === "storage_writer") {
        try {
          await request(
            "metadata-token-revocation",
            "/installation/token",
            token,
            undefined,
            "DELETE",
          );
        } catch (error) {
          cleanupFailure = { error };
        }
      }
    }
  })();
  if (originalFailure) {
    if (cleanupFailure)
      throw new AggregateError(
        [originalFailure.error, cleanupFailure.error],
        "installation observation and metadata token cleanup both failed; retain original receipts",
      );
    throw originalFailure.error;
  }
  if (cleanupFailure) throw cleanupFailure.error;
  if (!result) throw new Error("installation observation did not settle");
  const final = {
    ...result,
    api_requests: requests,
    ...(role === "storage_writer" ? { metadata_token_revoked: true } : {}),
  };
  await store.write("result.json", Buffer.from(JSON.stringify(final)));
  active(role === "storage_writer");
  return final;
}
