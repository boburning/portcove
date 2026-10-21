/** One-use job-local secret transport. This module establishes no release authority.
 * The fixed role worker opens it only after its private authenticated admission. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

export type IsolatedSigningRole =
  | "payload"
  | "releases"
  | "preview"
  | "stable"
  | "snapshot"
  | "timestamp"
  | "catalog-definitions"
  | "catalog-policy"
  | "catalog-snapshot"
  | "catalog-timestamp";
const roles = [
  "payload",
  "releases",
  "preview",
  "stable",
  "snapshot",
  "timestamp",
  "catalog-definitions",
  "catalog-policy",
  "catalog-snapshot",
  "catalog-timestamp",
] as const;
const maximum = 128 * 1024;
function role(raw: unknown): IsolatedSigningRole {
  if (!roles.some((value) => value === raw))
    throw new Error("fixed isolated signing role required");
  return raw as IsolatedSigningRole;
}
/** Closed appointed channel names. Catalog keys never fall back to app roles. */
export function isolatedRoleKeyEnvironment(raw: unknown) {
  const selected = role(raw);
  if (selected === "payload") return "TAURI_SIGNING_PRIVATE_KEY";
  if (selected === "catalog-definitions") return "PORTCOVE_CATALOG_DEFINITIONS_KEY";
  if (selected === "catalog-policy") return "PORTCOVE_CATALOG_POLICY_KEY";
  if (selected === "catalog-snapshot") return "PORTCOVE_CATALOG_SNAPSHOT_KEY";
  if (selected === "catalog-timestamp") return "PORTCOVE_CATALOG_TIMESTAMP_KEY";
  return `PORTCOVE_TUF_${selected.toUpperCase()}_KEY`;
}
function address(directory: string) {
  if (process.platform !== "linux" || !path.isAbsolute(directory))
    throw new Error("job-local Linux role key channel required");
  const socket = path.join(directory, "key.sock");
  if (Buffer.byteLength(socket) > 100)
    throw new Error("role key socket path exceeds platform bound");
  return socket;
}
function readFrame(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) {
        socket.destroy();
        reject(new Error("role key frame exceeds bound"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("error", () => reject(new Error("role key transport refused")));
    socket.once("end", () => {
      try {
        const bytes = Buffer.concat(chunks);
        if (!bytes.length || !Buffer.from(bytes.toString("utf8")).equals(bytes))
          throw new Error("role key frame is not bounded UTF-8");
        resolve(JSON.parse(bytes.toString("utf8")) as unknown);
      } catch {
        reject(new Error("role key frame is malformed"));
      }
    });
  });
}

/** Only an already authenticated fixed worker supplies this private closure.
 * The callback/result is never treated as acceptance by the transport. */
export async function receiveIsolatedRoleKey<T>(
  directory: string,
  rawRole: IsolatedSigningRole,
  deadline: number,
  consume: (key: string, password: string) => Promise<T>,
) {
  const selected = role(rawRole),
    socketPath = address(directory);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 30_000)
    throw new Error("role key release deadline is invalid");
  await mkdir(directory, { mode: 0o700 });
  const challenge = randomBytes(32).toString("hex");
  let peer: net.Socket | undefined;
  let server: net.Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let consuming = false,
        transportFailed = false;
      const fail = () => {
        peer?.destroy();
        if (consuming) {
          transportFailed = true;
          return;
        }
        reject(new Error("isolated role key handoff refused"));
      };
      timer = setTimeout(fail, Math.max(1, deadline - Date.now()));
      server = net.createServer({ allowHalfOpen: true }, (socket) => {
        if (peer) {
          socket.destroy();
          return;
        }
        peer = socket;
        server!.close();
        socket.on("error", fail);
        const frame = readFrame(socket);
        socket.write(`${JSON.stringify({ schema_version: 1, role: selected, challenge })}\n`);
        void frame
          .then(async (input) => {
            if (
              Date.now() >= deadline ||
              !isRecord(input) ||
              Object.keys(input).sort().join(",") !==
                "challenge,key,password,role,schema_version" ||
              input.schema_version !== 1 ||
              input.role !== selected ||
              typeof input.challenge !== "string" ||
              !/^[a-f0-9]{64}$/u.test(input.challenge) ||
              !timingSafeEqual(Buffer.from(input.challenge), Buffer.from(challenge)) ||
              typeof input.key !== "string" ||
              !input.key ||
              Buffer.byteLength(input.key) > 32 * 1024 ||
              typeof input.password !== "string" ||
              Buffer.byteLength(input.password) > 32 * 1024
            )
              throw new Error("role key handoff differs");
            clearTimeout(timer);
            consuming = true;
            const key = input.key,
              password = input.password;
            input.key = "";
            input.password = "";
            const result = await consume(key, password);
            if (transportFailed) throw new Error("role client disconnected during consumption");
            await new Promise<void>((finish, refused) =>
              socket.end('{"schema_version":1,"status":"consumed"}\n', (error?: Error) =>
                error ? refused(error) : finish(),
              ),
            );
            consuming = false;
            resolve(result);
          })
          .catch(() => {
            consuming = false;
            fail();
          });
      });
      server.once("error", fail);
      server.listen(socketPath, () => {
        void (async () => {
          await chmod(socketPath, 0o600);
          if (process.env.RUNNER_TEMP && process.env.PORTCOVE_JOB_OPERATION) {
            const { retainControllerRoleKey } = await import("./release-controller-transport.mts");
            await retainControllerRoleKey(process.env.RUNNER_TEMP, selected, directory);
          }
        })().catch(fail);
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    peer?.destroy();
    server?.close();
    await unlink(socketPath).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

/** The client validates the live worker challenge before reading its sole role
 * secret. No key file, public request or command argument is created. */
export async function supplyIsolatedRoleKey(
  directory: string,
  rawRole: IsolatedSigningRole,
  environment: NodeJS.ProcessEnv = process.env,
  phaseDeadline?: number,
) {
  const selected = role(rawRole),
    socketPath = address(directory);
  if (typeof process.getuid !== "function") throw new Error("role key owner unavailable");
  const owner = process.getuid();
  const folder = await lstat(directory),
    endpoint = await lstat(socketPath);
  if (
    !folder.isDirectory() ||
    folder.isSymbolicLink() ||
    folder.uid !== owner ||
    (folder.mode & 0o777) !== 0o700 ||
    !endpoint.isSocket() ||
    endpoint.uid !== owner ||
    (endpoint.mode & 0o777) !== 0o600 ||
    (await realpath(directory)) !== path.resolve(directory)
  )
    throw new Error("role key channel ownership differs");
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  const left = phaseDeadline === undefined ? 600000 : Math.floor(phaseDeadline - performance.now());
  if (!Number.isFinite(left) || left < 1 || left > 600000) {
    socket.destroy();
    throw new Error("original role key client deadline exhausted");
  }
  const timer = setTimeout(() => socket.destroy(new Error("role key client deadline")), left);
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0);
      let sent = false;
      socket.once("error", () => reject(new Error("isolated role key handoff refused")));
      socket.on("data", (chunk: Buffer) => {
        try {
          if (phaseDeadline !== undefined && performance.now() >= phaseDeadline)
            throw new Error("original role key client deadline exhausted");
          if (buffer.length + chunk.length > 4096)
            throw new Error("role worker response exceeds bound");
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(10);
          if (newline < 0) return;
          if (newline !== buffer.length - 1) throw new Error("role worker response is ambiguous");
          const input: unknown = JSON.parse(buffer.toString("utf8"));
          buffer = Buffer.alloc(0);
          if (!isRecord(input)) throw new Error("role worker response differs");
          if (sent) {
            if (
              Object.keys(input).sort().join(",") !== "schema_version,status" ||
              input.schema_version !== 1 ||
              input.status !== "consumed"
            )
              throw new Error("role worker completion differs");
            resolve();
            return;
          }
          if (
            Object.keys(input).sort().join(",") !== "challenge,role,schema_version" ||
            input.schema_version !== 1 ||
            input.role !== selected ||
            typeof input.challenge !== "string" ||
            !/^[a-f0-9]{64}$/u.test(input.challenge)
          )
            throw new Error("role worker challenge differs");
          const keyName = isolatedRoleKeyEnvironment(selected);
          const key = environment[keyName];
          const password =
            selected === "payload" ? (environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "") : "";
          if (!key || Buffer.byteLength(key) > 32 * 1024 || Buffer.byteLength(password) > 32 * 1024)
            throw new Error("fixed role key unavailable");
          sent = true;
          socket.end(JSON.stringify({ ...input, key, password }));
        } catch {
          reject(new Error("isolated role key handoff refused"));
          socket.destroy();
        }
      });
      socket.once("end", () => {
        if (!sent) reject(new Error("isolated role key handoff refused"));
      });
      socket.once("close", () => reject(new Error("isolated role key handoff refused")));
    });
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function settleDirectCli() {
  if (
    process.argv[1] &&
    /^release-role-key-channel[.](?:mts|mjs|bundle[.]mjs)$/u.test(path.basename(process.argv[1])) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  ) {
    try {
      if (process.argv.length !== 4)
        throw new Error("fixed role and private socket directory required");
      await supplyIsolatedRoleKey(process.argv[3]!, role(process.argv[2]));
    } catch {
      console.error("isolated role key handoff refused; no credential diagnostic retained");
      process.exitCode = 1;
    }
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
