import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import {
  inspectHostedReleaseAppIdentity,
  prepareHostedReleaseAppManifest,
  type HostedReleaseAppRole,
} from "./release-hosted-app-setup.mts";
import { prepareSemanticAppJwt } from "./release-semantic-issuer.mts";
import { isRecord } from "./runtime-values.mts";

const maximumBody = 128 * 1024;
export interface AppRegistrationStore {
  write(name: string, bytes: Buffer): Promise<void>;
}
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

/** Linux owner-only custody outside the reviewer namespace. Existing attempts,
 * linked/foreign/writable ancestry and non-private modes are refused, never
 * repaired or overwritten. There is no credential in the repository or stdout. */
export async function createAppRegistrationStore(directory: string): Promise<AppRegistrationStore> {
  const uid = process.getuid?.();
  if (
    process.platform !== "linux" ||
    uid === undefined ||
    uid === 0 ||
    !path.isAbsolute(directory) ||
    path.normalize(directory) !== directory
  )
    throw new Error("ordinary native Linux registration custody required");
  const parent = path.dirname(directory);
  if ((await realpath(parent)) !== parent) throw new Error("linked registration parent refused");
  for (let cursor = parent; ; cursor = path.dirname(cursor)) {
    const stat = await lstat(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ![0, uid].includes(stat.uid) ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error("registration ancestry is linked, foreign-owned or writable");
    if (path.dirname(cursor) === cursor) break;
  }
  await mkdir(directory, { mode: 0o700 });
  const owner = await lstat(directory);
  if (!owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o077) !== 0)
    throw new Error("private registration directory unavailable");
  let total = 0,
    files = 0;
  return {
    async write(name, bytes) {
      if (
        !/^[a-z][a-z0-9-]{0,48}\.(?:json|body|pem)$/u.test(name) ||
        bytes.length > maximumBody ||
        total + bytes.length > 384 * 1024 ||
        files >= 16
      )
        throw new Error("registration retained-storage boundary exceeded");
      if ((await realpath(directory)) !== directory)
        throw new Error("registration custody changed");
      const stat = await lstat(directory);
      if (stat.uid !== uid || (stat.mode & 0o077) !== 0)
        throw new Error("registration custody changed");
      const file = await open(path.join(directory, name), "wx", 0o600);
      files++;
      try {
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.uid !== uid ||
          opened.nlink !== 1 ||
          (opened.mode & 0o077) !== 0
        )
          throw new Error("private registration file identity differs");
        total += bytes.length;
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    },
  };
}

export function inspectAppRegistrationCallback(
  role: HostedReleaseAppRole,
  state: string,
  request: { method: string; host: string; remote_address: string; url: string },
) {
  if (
    !/^[a-f0-9]{64}$/u.test(state) ||
    request.method !== "GET" ||
    request.host !== "127.0.0.1:1456" ||
    !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.remote_address) ||
    request.url.length > 4096 ||
    !request.url.startsWith("/") ||
    request.url.startsWith("//")
  )
    throw new Error("fixed registration callback boundary differs");
  const url = new URL(request.url, "http://127.0.0.1:1456");
  const fields = [...url.searchParams.keys()].sort().join(",");
  if (
    url.pathname !== `/portcove-app-setup/${role}` ||
    url.hash ||
    fields !== "code,state" ||
    url.searchParams.get("state") !== state ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(url.searchParams.get("code") ?? "")
  )
    throw new Error("registration callback state, role or code differs");
  return url.searchParams.get("code")!;
}

/** One direct callback -> one conversion. No imported transcript or default
 * credential lookup. Failed/ambiguous effects stay pending for explicit
 * readback; the consumed closure can never issue a second conversion POST. */
export function createAppRegistrationCapture(options: {
  role: HostedReleaseAppRole;
  state: string;
  deadline: number;
  store: AppRegistrationStore;
  transport?: typeof fetch;
}) {
  const { role, state, deadline, store } = options;
  prepareHostedReleaseAppManifest(role);
  let consumed = false;
  const transport = options.transport ?? fetch;
  const record = (name: string, value: unknown) =>
    store.write(name, Buffer.from(JSON.stringify(value)));
  const active = () => {
    if (!Number.isSafeInteger(deadline) || Date.now() >= deadline)
      throw new Error("original App registration deadline expired");
  };
  const request = async (kind: "conversion" | "app-readback", codeOrJwt: string) => {
    active();
    const conversion = kind === "conversion";
    let response: Response;
    let readFailed = false,
      retentionFailed = false;
    try {
      response = await transport(
        conversion
          ? `https://api.github.com/app-manifests/${codeOrJwt}/conversions`
          : "https://api.github.com/app",
        {
          method: conversion ? "POST" : "GET",
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(10000, deadline - Date.now())),
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "portcove-fixed-app-registration",
            ...(conversion ? {} : { Authorization: `Bearer ${codeOrJwt}` }),
          },
        },
      );
    } catch {
      await record(`${kind}-transport.json`, {
        response: "unavailable",
        effect: conversion ? "unknown" : "read-only",
        automatic_retry: false,
      });
      throw new Error("registration transport ambiguous; no retry");
    }
    const chunks: Buffer[] = [];
    let total = 0,
      complete = false;
    const reader = response.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    try {
      if (!reader) throw new Error("registration response body absent");
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          complete = true;
          break;
        }
        const bytes = Buffer.from(part.value);
        const retained = bytes.subarray(0, maximumBody - total);
        chunks.push(retained);
        total += retained.length;
        if (retained.length !== bytes.length) break;
      }
    } catch {
      readFailed = true;
    } finally {
      try {
        await reader?.cancel();
      } catch {
        /* Original partial body remains. */
      }
      const body = Buffer.concat(chunks);
      try {
        await store.write(`${kind}.body`, body);
        await record(`${kind}-response.json`, {
          status: response.status,
          complete,
          retained_bytes: body.length,
          retained_sha256: sha(body),
        });
      } catch {
        retentionFailed = true;
      }
    }
    if (readFailed || retentionFailed)
      throw new Error("registration body or private retention failed; preserve pending intent");
    const body = Buffer.concat(chunks);
    active();
    if (!complete || response.status !== (conversion ? 201 : 200))
      throw new Error("registration response incomplete or refused; retain actual effects");
    return JSON.parse(body.toString("utf8")) as unknown;
  };
  return async (incoming: Parameters<typeof inspectAppRegistrationCallback>[2]) => {
    const code = inspectAppRegistrationCallback(role, state, incoming);
    active();
    if (consumed || deadline - Date.now() < 20000)
      throw new Error("registration already consumed or insufficient original deadline");
    consumed = true;
    await record("conversion-intent.json", {
      role,
      code,
      deadline,
      phase: "pending",
      effect: "unresolved",
      automatic_retry: false,
    });
    const converted = await request("conversion", code);
    if (
      !isRecord(converted) ||
      typeof converted.id !== "number" ||
      typeof converted.pem !== "string" ||
      Buffer.byteLength(converted.pem) > 16384
    )
      throw new Error("converted App identity or private key unavailable");
    inspectHostedReleaseAppIdentity(role, converted.id, converted);
    const pem = Buffer.from(converted.pem);
    try {
      const key = createPrivateKey(pem);
      const fingerprint = sha(createPublicKey(key).export({ type: "spki", format: "der" }));
      const jwt = prepareSemanticAppJwt(
        pem,
        converted.id,
        fingerprint,
        Math.floor(Date.now() / 1000),
      );
      await store.write("app.pem", pem);
      const observed = await request("app-readback", jwt);
      const identity = inspectHostedReleaseAppIdentity(role, converted.id, observed);
      if (
        !isRecord(observed) ||
        typeof observed.slug !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(observed.slug) ||
        observed.slug.length > 100
      )
        throw new Error("authenticated App installation locator unavailable");
      const result = {
        ...identity,
        public_key_sha256: fingerprint,
        install_url: `https://github.com/apps/${observed.slug}/installations/new`,
        installation_repository_scope: "not-established",
        acceptance: "not-established",
        authority: "none",
        automatic_retry: false,
      };
      await record("result.json", result);
      active();
      return result;
    } finally {
      pem.fill(0);
    }
  };
}
