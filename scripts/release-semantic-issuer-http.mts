import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { releaseCanonicalDigest as capacityDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

/** Fixed credential transport, never a review/issuer authority. The parent
 * supplies credentials through stdin only after the existing capture guard. */
export function inspectSemanticIssuerRequest(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "body,configuration,endpoint,kind,method,token" ||
    !isRecord(raw.configuration) ||
    Object.keys(raw.configuration).sort().join(",") !==
      "app_id,check_body_sha256,head,installation_id" ||
    ![raw.configuration.app_id, raw.configuration.installation_id].every(
      (id) => Number.isSafeInteger(id) && Number(id) > 0,
    ) ||
    !/^[a-f0-9]{40}$/u.test(String(raw.configuration.head)) ||
    !/^[a-f0-9]{64}$/u.test(String(raw.configuration.check_body_sha256)) ||
    typeof raw.token !== "string" ||
    raw.token.length < 1 ||
    raw.token.length > 16384 ||
    /[^\x21-\x7e]/u.test(raw.token) ||
    typeof raw.endpoint !== "string"
  )
    throw new Error("fixed semantic credential request differs");
  const config = raw.configuration;
  const installationId = String(config.installation_id),
    head = String(config.head);
  const repository = "repos/boburning/portcove";
  const tokenEndpoint = `app/installations/${installationId}/access_tokens`;
  const allowed =
    raw.kind === "app"
      ? (raw.method === "GET" &&
          raw.body === null &&
          ["app", `app/installations/${installationId}`].includes(raw.endpoint)) ||
        (raw.method === "POST" &&
          raw.endpoint === tokenEndpoint &&
          capacityDigest(raw.body) ===
            capacityDigest({
              repository_ids: [1354613114],
              permissions: { checks: "write", metadata: "read" },
            }))
      : raw.kind === "installation" &&
        ((raw.method === "GET" &&
          raw.body === null &&
          (raw.endpoint === "installation/repositories?per_page=100" ||
            raw.endpoint === repository ||
            new RegExp(`^${repository}/check-runs/[1-9][0-9]{0,15}$`, "u").test(raw.endpoint) ||
            new RegExp(
              `^${repository}/commits/${head}/check-suites\\?app_id=${String(config.app_id)}&per_page=100&page=1$`,
              "u",
            ).test(raw.endpoint) ||
            new RegExp(
              `^${repository}/check-suites/[1-9][0-9]{0,15}/check-runs\\?check_name=Portcove%20independent%20release%20semantic%20review&filter=all&per_page=100&page=(?:[1-9]|10)$`,
              "u",
            ).test(raw.endpoint))) ||
          (raw.method === "POST" &&
            raw.endpoint === `${repository}/check-runs` &&
            capacityDigest(raw.body) === config.check_body_sha256));
  if (!allowed) throw new Error("semantic credential request escaped the fixed broker routes");
  return {
    method: String(raw.method),
    endpoint: raw.endpoint,
    body: structuredClone(raw.body),
    token: raw.token,
  };
}

async function main() {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of process.stdin) {
    const value: unknown = part;
    if (!(Buffer.isBuffer(value) || typeof value === "string"))
      throw new Error("semantic credential stdin is not bytes");
    const bytes = Buffer.from(value);
    if ((length += bytes.length) > 128 * 1024)
      throw new Error("semantic credential input exceeded bound");
    parts.push(bytes);
  }
  const request = inspectSemanticIssuerRequest(JSON.parse(Buffer.concat(parts).toString("utf8")));
  const response = await fetch(`https://api.github.com/${request.endpoint}`, {
    method: request.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${request.token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "portcove-fixed-semantic-broker",
      ...(request.body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((total += value.length) > 2 * 1024 * 1024)
          throw new Error("semantic credential response exceeded bound");
        chunks.push(value);
      }
  } finally {
    await reader?.cancel();
  }
  const body: unknown = JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  // This private pipe may contain a newly minted token. It is consumed only by
  // the parent, never inherited by the reviewer or retained in a report.
  process.stdout.write(
    JSON.stringify({ status: response.status, headers: [...response.headers], body }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not interpolate provider errors, bodies, headers or credentials.
    process.stderr.write(
      "semantic credential HTTP transport failed; reconcile any attempted effect before retry\n",
    );
    process.exitCode = 1;
  });
}
