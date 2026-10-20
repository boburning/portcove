import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyDirectSemanticCapture,
  requireDirectSemanticDispositionCapture,
} from "./release-semantic-runtime.mts";
import type { runSemanticRuntime } from "./release-semantic-runtime.mts";
import type { SemanticIssuer } from "./release-semantic-broker.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";

export interface SemanticIssuerCustody {
  issuer: SemanticIssuer;
  private_key: string;
  public_key_sha256: string;
  node_sha256: string;
  http_modules_sha256: {
    "release-semantic-issuer-http.mts": string;
    "release-canonical.mts": string;
    "runtime-values.mts": string;
  };
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Pure signing primitive for the selected App's short-lived RS256 token.
 * Calling this with imported bytes never grants review or provisioning authority. */
export function prepareSemanticAppJwt(
  pem: Buffer,
  appId: number,
  expectedPublicKeySha256: string,
  now: number,
) {
  if (
    !Number.isSafeInteger(appId) ||
    appId < 1 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    pem.length > 16 * 1024 ||
    !/^[a-f0-9]{64}$/u.test(expectedPublicKeySha256)
  )
    throw new Error("semantic App signing identity unavailable");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" || Number(key.asymmetricKeyDetails?.modulusLength) < 2048)
    throw new Error("semantic App requires its selected RSA key");
  const publicBytes = createPublicKey(key).export({ type: "spki", format: "der" });
  if (sha(publicBytes) !== expectedPublicKeySha256)
    throw new Error("semantic App public-key identity changed");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 300, iss: String(appId) })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}

async function readPrivateKey(filename: string) {
  if (
    process.platform !== "linux" ||
    !path.isAbsolute(filename) ||
    (await realpath(filename)) !== filename
  )
    throw new Error("semantic issuer custody requires its canonical native Linux path");
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0)
    throw new Error("semantic issuer requires the ordinary broker owner");
  for (let cursor = filename; ; cursor = path.dirname(cursor)) {
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022) !== 0)
      throw new Error("semantic issuer custody ancestry is linked, foreign-owned or writable");
    if (
      cursor === filename &&
      (!stat.isFile() ||
        stat.uid !== uid ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 1 ||
        stat.size > 16 * 1024 ||
        stat.nlink !== 1)
    )
      throw new Error("semantic issuer private key must be an owner-only bounded regular file");
    if (path.dirname(cursor) === cursor) break;
  }
  const bytes = await readBoundedPublicBuildInputFile(
    path.dirname(filename),
    path.basename(filename),
    16 * 1024,
  );
  return bytes;
}

/** Actual accepted capture is checked before even reading issuer custody.
 * The existing broker separately checks the provisioning grant before calling
 * this adapter and authenticates App/installation/repository/permissions after.
 * No ambient token/config, retry, transcript import or reviewer access exists. */
export async function authenticateCapturedSemanticIssuer(
  capture: Awaited<ReturnType<typeof runSemanticRuntime>>,
  raw: SemanticIssuerCustody,
) {
  const actual = await verifyDirectSemanticCapture(capture);
  return authenticateSemanticIssuerRequest(actual.handoff.proposed_request.body, raw);
}

export async function authenticateCapturedSemanticDisposition(
  value: unknown,
  raw: SemanticIssuerCustody,
) {
  const actual = await requireDirectSemanticDispositionCapture(value);
  return authenticateSemanticIssuerRequest(actual.proposed_request.body, raw);
}

async function authenticateSemanticIssuerRequest(
  checkBody: { head_sha: string },
  raw: SemanticIssuerCustody,
) {
  const config = structuredClone(raw);
  if (
    Object.keys(config).sort().join(",") !==
      "http_modules_sha256,issuer,node_sha256,private_key,public_key_sha256" ||
    Object.keys(config.issuer).sort().join(",") !== "app_id,installation_id,writer_app_id" ||
    ![config.issuer.app_id, config.issuer.installation_id, config.issuer.writer_app_id].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    config.issuer.app_id === config.issuer.writer_app_id ||
    config.issuer.app_id === 15368 ||
    Object.keys(config.http_modules_sha256).sort().join(",") !==
      "release-canonical.mts,release-semantic-issuer-http.mts,runtime-values.mts" ||
    ![
      config.public_key_sha256,
      config.node_sha256,
      ...Object.values(config.http_modules_sha256),
    ].every((digest) => /^[a-f0-9]{64}$/u.test(digest))
  )
    throw new Error("selected semantic issuer custody configuration differs");
  const worker = fileURLToPath(new URL("./release-semantic-issuer-http.mts", import.meta.url));
  const verifyTools = async () => {
    if (sha(await readFile(process.execPath)) !== config.node_sha256)
      throw new Error("semantic issuer transport executable changed");
    verifyHttpModules();
  };
  const verifyHttpModules = () => {
    for (const [name, expected] of Object.entries(config.http_modules_sha256))
      if (sha(readFileSync(new URL(name, import.meta.url))) !== expected)
        throw new Error("semantic issuer HTTP source closure changed");
  };
  await verifyTools();
  const bytes = await readPrivateKey(config.private_key);
  let jwt: string;
  try {
    jwt = prepareSemanticAppJwt(
      bytes,
      config.issuer.app_id,
      config.public_key_sha256,
      Math.floor(Date.now() / 1000),
    );
  } finally {
    bytes.fill(0);
  }
  await verifyTools();
  const started = Date.now();
  let requests = 0;
  const configuration = {
    app_id: config.issuer.app_id,
    installation_id: config.issuer.installation_id,
    head: checkBody.head_sha,
    check_body_sha256: capacityDigest(checkBody),
  };
  const client = (kind: "app" | "installation", token: string): CoordinatorRemoteApi => ({
    request(method, endpoint, body = null) {
      verifyHttpModules();
      if (++requests > 40 || Date.now() - started > 120000)
        throw new Error("semantic credential session bound exhausted");
      let result: unknown;
      try {
        const output = execFileSync(process.execPath, [worker], {
          input: JSON.stringify({ kind, token, configuration, method, endpoint, body }),
          encoding: "utf8",
          timeout: Math.min(12000, 120000 - (Date.now() - started)),
          maxBuffer: 3 * 1024 * 1024,
          windowsHide: true,
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        result = JSON.parse(output);
        verifyHttpModules();
      } catch {
        throw new Error(
          "semantic credential request failed; read back any attempted effect before retry",
        );
      }
      if (
        !isRecord(result) ||
        typeof result.status !== "number" ||
        !Array.isArray(result.headers) ||
        Date.now() - started > 120000
      )
        throw new Error("semantic credential response incomplete or late");
      return { status: result.status, headers: new Map(result.headers), body: result.body };
    },
    graphql() {
      throw new Error("semantic issuer cannot access GraphQL");
    },
  });
  const app = client("app", jwt);
  const response = app.request(
    "POST",
    `app/installations/${config.issuer.installation_id}/access_tokens`,
    { repository_ids: [1354613114], permissions: { checks: "write", metadata: "read" } },
  );
  const value = response.body;
  if (
    response.status !== 201 ||
    !isRecord(value) ||
    typeof value.token !== "string" ||
    !value.token ||
    value.token.length > 16384 ||
    /[^\x21-\x7e]/u.test(value.token) ||
    !isRecord(value.permissions) ||
    capacityDigest(value.permissions) !== capacityDigest({ checks: "write", metadata: "read" }) ||
    typeof value.expires_at !== "string" ||
    Date.parse(value.expires_at) <= Date.now() ||
    Date.parse(value.expires_at) > Date.now() + 65 * 60 * 1000
  )
    throw new Error("semantic installation token boundary unavailable");
  return { app, installation: client("installation", value.token) };
}
