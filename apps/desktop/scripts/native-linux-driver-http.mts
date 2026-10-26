/** WebDriver-only HTTP over the owned namespace control channel. This agent
 * never creates a network socket and carries no native acceptance authority. */
import { Agent } from "node:http";
import { Duplex } from "node:stream";
import { isRecord } from "../../../scripts/runtime-values.mts";

const requestLimit = 2 * 1024 * 1024;
const responseLimit = 16 * 1024 * 1024;
const states = new WeakMap<Agent, { requests: number; body_bytes: number; refused: boolean }>();
export function privateNativeDriverAgentState(agent: Agent) {
  const state = states.get(agent);
  if (!state) throw new Error("owned private native driver agent required");
  return Object.freeze({ ...state, authority: "none" as const });
}
export interface PrivateNativeDriverRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body_base64: string;
}
export interface PrivateNativeDriverResponse {
  status: number;
  body_base64: string;
}
function base64(raw: unknown, maximum: number) {
  if (
    typeof raw !== "string" ||
    raw.length > 4 * Math.ceil(maximum / 3) ||
    raw.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(raw)
  )
    throw new Error("private native driver body is not bounded canonical base64");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== raw)
    throw new Error("private native driver body differs");
  return bytes;
}
export function inspectPrivateNativeDriverRequest(raw: unknown): PrivateNativeDriverRequest {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "body_base64,method,path" ||
    !["GET", "POST", "DELETE"].includes(String(raw.method)) ||
    typeof raw.path !== "string" ||
    raw.path.length > 2048 ||
    !/^\/(?:status|native-runtime|native-public-runtime|session(?:\/[A-Za-z0-9._-]+)*)$/u.test(
      raw.path,
    ) ||
    raw.path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("private native driver route differs from the fixed WebDriver surface");
  const bytes = base64(raw.body_base64, requestLimit);
  if (
    ["/native-runtime", "/native-public-runtime"].includes(raw.path) &&
    (raw.method !== "GET" || bytes.length)
  )
    throw new Error("native runtime observation is read-only");
  if (raw.method !== "POST" && bytes.length !== 0)
    throw new Error("private native driver read/delete body is unexpected");
  return Object.freeze({
    method: raw.method as PrivateNativeDriverRequest["method"],
    path: raw.path,
    body_base64: bytes.toString("base64"),
  });
}
export function inspectPrivateNativeDriverResponse(raw: unknown): PrivateNativeDriverResponse {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "body_base64,status" ||
    !Number.isSafeInteger(raw.status) ||
    Number(raw.status) < 200 ||
    Number(raw.status) > 599
  )
    throw new Error("private native driver response identity differs");
  return Object.freeze({
    status: Number(raw.status),
    body_base64: base64(raw.body_base64, responseLimit).toString("base64"),
  });
}

function parsePrivateNativeHttpRequest(bytes: Buffer) {
  const separator = bytes.indexOf("\r\n\r\n");
  if (separator < 0) {
    if (bytes.length > 16384) throw new Error("private native driver headers exceed bound");
    return null;
  }
  if (separator > 16384) throw new Error("private native driver headers exceed bound");
  const lines = bytes.subarray(0, separator).toString("latin1").split("\r\n");
  const start = /^(GET|POST|DELETE) (\S+) HTTP\/1\.1$/u.exec(lines.shift() ?? "");
  if (!start) throw new Error("private native driver HTTP request line differs");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/u.exec(line);
    if (!match || headers.has(match[1]!.toLowerCase()))
      throw new Error("private native driver headers are ambiguous");
    headers.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  if (headers.has("transfer-encoding") || headers.has("upgrade"))
    throw new Error("private native driver streaming/upgrade is unsupported");
  const length = headers.get("content-length") ?? "0";
  if (!/^(?:0|[1-9][0-9]{0,6})$/u.test(length) || Number(length) > requestLimit)
    throw new Error("private native driver content length differs");
  const expected = separator + 4 + Number(length);
  if (bytes.length > expected) throw new Error("private native driver trailing bytes refused");
  if (bytes.length < expected) {
    return null;
  }
  const request = inspectPrivateNativeDriverRequest({
    method: start[1],
    path: start[2],
    body_base64: bytes.subarray(separator + 4).toString("base64"),
  });
  return { request, bodyBytes: Number(length) };
}

/** The namespace owner supplies the private FD exchange. Injected exchanges
 * remain transport fixtures and cannot establish a genuine parent or report. */
export function privateNativeDriverAgent(
  exchange: (request: PrivateNativeDriverRequest) => Promise<unknown>,
  deadline: number,
) {
  if (typeof exchange !== "function" || !Number.isFinite(deadline))
    throw new Error("private native driver requires its original finite deadline");
  const agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
  const state = { requests: 0, body_bytes: 0, refused: false };
  states.set(agent, state);
  agent.createConnection = () => {
    if (state.refused)
      throw new Error("private native driver attempt is refused; retain original channel evidence");
    let bytes = Buffer.alloc(0),
      sent = false,
      settled = false;
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        try {
          if (chunk.length === 0) {
            callback();
            return;
          }
          if (sent || bytes.length + chunk.length > requestLimit + 16384)
            throw new Error("private native driver request exceeds its finite boundary");
          bytes = Buffer.concat([bytes, chunk]);
          const parsed = parsePrivateNativeHttpRequest(bytes);
          if (!parsed) {
            callback();
            return;
          }
          const { request, bodyBytes } = parsed;
          const remaining = Math.floor(Math.min(30000, deadline - performance.now()));
          state.body_bytes += bodyBytes;
          if (remaining < 1 || ++state.requests > 4096 || state.body_bytes > 128 * 1024 * 1024)
            throw new Error("private native driver original lifetime/request budget exhausted");
          sent = true;
          bytes = Buffer.alloc(0);
          const timer = setTimeout(() => {
            state.refused = true;
            stream.destroy(new Error("private native driver exchange deadline exhausted"));
          }, remaining);
          stream.once("close", () => {
            clearTimeout(timer);
            if (!settled) state.refused = true;
          });
          void Promise.resolve()
            .then(() => exchange(request))
            .then((raw) => {
              const response = inspectPrivateNativeDriverResponse(raw);
              if (stream.destroyed) return;
              if (performance.now() >= deadline)
                throw new Error("private native driver original lifetime exhausted after readback");
              const body = Buffer.from(response.body_base64, "base64");
              state.body_bytes += body.length;
              if (state.body_bytes > 128 * 1024 * 1024)
                throw new Error("private native driver total response boundary exhausted");
              settled = true;
              stream.push(
                Buffer.from(
                  `HTTP/1.1 ${response.status} Native Driver\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
                ),
              );
              stream.push(body);
              stream.push(null);
            })
            .catch(() => {
              state.refused = true;
              // Selenium retries network-coded errors automatically. Preserve
              // the original failure in the owner's channel receipt, then
              // refuse this attempt without exposing a retryable network code.
              stream.destroy(
                new Error("private native driver exchange refused; retain channel evidence"),
              );
            })
            .finally(() => clearTimeout(timer));
          callback();
        } catch (error) {
          state.refused = true;
          callback(error instanceof Error ? error : new Error("private native driver refused"));
        }
      },
    });
    return stream;
  };
  return agent;
}
