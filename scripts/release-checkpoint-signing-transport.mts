/** Fixed HTTP seam for the pinned official Sigstore SDK. No retry, alternate
 * destination, credential discovery, or response can appoint an authority. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AppRegistrationStore } from "./release-app-registration-capture.mts";
import { isRecord } from "./runtime-values.mts";

export const checkpointSigningEndpoints = Object.freeze([
  "https://fulcio.sigstore.dev/api/v2/signingCert",
  "https://rekor.sigstore.dev/api/v1/log/entries",
] as const);
const maximumBytes = 64 * 1024;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function createCheckpointSigningTransport(
  store: AppRegistrationStore,
  deadline: number,
  fetcher: typeof fetch = fetch,
  secrets: readonly string[] = [],
  beforePost?: (stage: "fulcio" | "rekor") => Promise<void>,
) {
  const forbidden = [...secrets];
  if (
    forbidden.length > 2 ||
    forbidden.some(
      (value) => typeof value !== "string" || !value || Buffer.byteLength(value) > 16384,
    )
  )
    throw new Error("bounded non-retained signing secrets required");
  let next = 0;
  let failed = false;
  let inFlight = false;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (!Number.isFinite(deadline) || value < 1 || value > 120000)
      throw new Error("checkpoint signing original deadline exhausted");
    return Math.min(value, 15000);
  };
  remaining();
  return {
    get completedRequests() {
      return next;
    },
    async request(url: string, rawOptions: unknown) {
      if (failed || inFlight) throw new Error("checkpoint signing attempt requires recovery");
      inFlight = true;
      const stage = next === 0 ? "fulcio" : "rekor";
      try {
        remaining();
        if (
          next >= 2 ||
          url !== checkpointSigningEndpoints[next] ||
          !isRecord(rawOptions) ||
          Object.keys(rawOptions).some(
            (key) => !["method", "headers", "body", "retry", "timeout"].includes(key),
          ) ||
          (rawOptions.method !== undefined && rawOptions.method !== "POST") ||
          rawOptions.retry !== 0 ||
          typeof rawOptions.timeout !== "number" ||
          !Number.isFinite(rawOptions.timeout) ||
          rawOptions.timeout < 1 ||
          rawOptions.timeout > 15000 ||
          typeof rawOptions.body !== "string" ||
          Buffer.byteLength(rawOptions.body) < 1 ||
          Buffer.byteLength(rawOptions.body) > maximumBytes ||
          !isRecord(rawOptions.headers) ||
          rawOptions.headers["Content-Type"] !== "application/json" ||
          Object.entries(rawOptions.headers).some(
            ([key, value]) =>
              !["Content-Type", "Accept"].includes(key) || value !== "application/json",
          )
        )
          throw new Error("checkpoint signing request differs from the fixed SDK exchange");
        const body = Buffer.from(rawOptions.body);
        // Never persist Fulcio's OIDC bearer. Rekor input is public attestation
        // material and is retained privately for an explicit readback/recovery.
        if (stage === "rekor") await store.write("rekor-request.body", body);
        await store.write(
          `${stage}-intent.json`,
          Buffer.from(
            JSON.stringify({
              schema_version: 1,
              method: "POST",
              url,
              body_sha256: sha(body),
              body_bytes: body.length,
              possible_remote_effect: true,
              automatic_retry: false,
            }),
          ),
        );
        // Custody can await/fsync. Recheck the owning journal/session/control
        // boundary AFTER those writes, immediately before the provider POST.
        remaining();
        await beforePost?.(stage);
        const timeout = remaining();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async () => {
          const response = await fetcher(url, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "Accept-Encoding": "identity",
            },
            body,
          });
          if (controller.signal.aborted) throw new Error("late signing response");
          remaining();
          if (
            ![200, 201].includes(response.status) ||
            !response.body ||
            !/^application\/json(?:\s*;.*)?$/iu.test(response.headers.get("content-type") ?? "") ||
            ![null, "identity"].includes(response.headers.get("content-encoding"))
          )
            throw new Error("signing provider response refused");
          const length = response.headers.get("content-length");
          if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maximumBytes))
            throw new Error("signing provider response exceeds its byte bound");
          const parts: Buffer[] = [];
          let size = 0;
          const reader = response.body.getReader();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (controller.signal.aborted) throw new Error("late signing response body");
              remaining();
              if (chunk.done) break;
              const value: unknown = chunk.value;
              if (!(value instanceof Uint8Array))
                throw new Error("signing response body is not byte data");
              size += value.byteLength;
              if (size > maximumBytes)
                throw new Error("signing provider response exceeds its byte bound");
              parts.push(Buffer.from(value));
            }
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const bytes = Buffer.concat(parts);
          if (!bytes.length || !Buffer.from(bytes.toString("utf8")).equals(bytes))
            throw new Error("signing response is not bounded UTF-8 JSON");
          return bytes;
        };
        let bytes: Buffer;
        try {
          bytes = await Promise.race([
            read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("signing provider operation deadline exhausted"));
              }, timeout);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
        }
        // Reflected credentials are forbidden even on HTTP 200. Check decoded
        // JSON as well as raw text before any response enters retained custody.
        const text = bytes.toString("utf8");
        let normalized = text;
        try {
          normalized = JSON.stringify(JSON.parse(text));
        } catch {
          /* Nonsecret malformed response is retained below. */
        }
        if (
          forbidden.some((secret) =>
            [
              secret,
              Buffer.from(secret).toString("base64"),
              Buffer.from(secret).toString("base64url"),
            ].some((encoded) => text.includes(encoded) || normalized.includes(encoded)),
          )
        ) {
          await store.write(
            `${stage}-redacted.json`,
            Buffer.from(
              JSON.stringify({
                schema_version: 1,
                response_sha256: sha(bytes),
                response_bytes: bytes.length,
                response_retained: false,
                reason: "credential-reflection",
                automatic_retry: false,
              }),
            ),
          );
          throw new Error("signing provider credential reflection refused");
        }
        // A successful HTTP response is its own observation, even if parsing or
        // SDK certificate/log validation subsequently refuses it.
        await store.write(`${stage}-response.body`, bytes);
        remaining();
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        next++;
        inFlight = false;
        return {
          async json(): Promise<unknown> {
            return structuredClone(parsed);
          },
        };
      } catch {
        failed = true;
        try {
          await store.write(
            `${stage}-failure.json`,
            Buffer.from(
              JSON.stringify({
                schema_version: 1,
                phase: stage,
                remote_effect: "unknown",
                automatic_retry: false,
                recovery_required: true,
                provider_error_text_retained: false,
              }),
            ),
          );
        } catch {
          /* Original intent/partial effects remain retained. */
        }
        // SDK/provider errors may contain the bearer or a reflected request.
        throw new Error(`checkpoint signing ${stage} refused; retained attempt requires recovery`);
      }
    },
  };
}
