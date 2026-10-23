import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareHostedReleaseAppManifest,
  type HostedReleaseAppRole,
} from "./release-hosted-app-setup.mts";
import {
  createAppRegistrationCapture,
  createAppRegistrationStore,
  inspectAppRegistrationCallback,
} from "./release-app-registration-capture.mts";

const origin = "http://127.0.0.1:1456";
const escaped = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Fixed loopback routes only. A replay cannot terminate or replace an original
 * in-flight conversion. No remote address, callback code or secret response is
 * reflected into browser content, logs or public results. */
export function createAppRegistrationHandler(options: {
  role: HostedReleaseAppRole;
  state: string;
  recordBegin: () => Promise<void>;
  capture: ReturnType<typeof createAppRegistrationCapture>;
  finish: (
    result: Awaited<ReturnType<ReturnType<typeof createAppRegistrationCapture>>> | null,
  ) => Promise<void>;
}) {
  const manifest = prepareHostedReleaseAppManifest(options.role);
  let served = false,
    claimed = false,
    requests = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body: string) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(body);
    };
    if (
      ++requests > 32 ||
      request.method !== "GET" ||
      request.headers.host !== "127.0.0.1:1456" ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
      request.headers["transfer-encoding"] ||
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") ||
      !request.url ||
      request.url.length > 4096
    ) {
      reply(400, "Request refused.");
      return;
    }
    if (request.url === `/portcove-app-setup/${options.role}/begin`) {
      if (served) {
        reply(409, "Registration page already delivered. Preserve the original attempt.");
        return;
      }
      served = true;
      try {
        await options.recordBegin();
      } catch {
        reply(502, "Private pending intent unavailable; registration stopped.");
        await options.finish(null);
        return;
      }
      reply(
        200,
        `<h1>Portcove ${escaped(options.role)} setup</h1><p>Production remains held. No keys will appear in this browser.</p><form method="post" action="https://github.com/settings/apps/new?state=${options.state}"><input type="hidden" name="manifest" value="${escaped(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>`,
      );
      return;
    }
    const incoming = {
      method: request.method,
      host: request.headers.host,
      remote_address: request.socket.remoteAddress ?? "",
      url: request.url,
    };
    try {
      inspectAppRegistrationCallback(options.role, options.state, incoming);
    } catch {
      reply(400, "Callback refused; original registration remains pending.");
      return;
    }
    if (!served || claimed) {
      reply(409, "Original registration is pending or already consumed.");
      return;
    }
    claimed = true;
    try {
      const result = await options.capture(incoming);
      reply(
        200,
        "<h1>App identity captured privately</h1><p>Return to Portcove setup. Installation, custody and protected activation are separate.</p>",
      );
      await options.finish(result);
    } catch {
      reply(
        502,
        "<h1>Setup stopped</h1><p>Original evidence and partial effects are retained. No automatic retry. Return to Portcove setup for readback.</p>",
      );
      await options.finish(null);
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--role" ||
    !["semantic", "protection_observer"].includes(args[1] ?? "") ||
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    userInfo().username !== "boburning" ||
    userInfo().homedir !== "/home/boburning" ||
    process.env.GITHUB_ACTIONS ||
    process.env.SUDO_UID
  )
    throw new Error("fixed ordinary-owner Linux App registration required");
  const role = args[1] as HostedReleaseAppRole;
  const state = randomBytes(32).toString("hex");
  const deadline = Date.now() + 600000;
  const directory = `/home/boburning/.local/share/portcove/app-registration/${role}`;
  const server = createServer();
  server.maxConnections = 4;
  server.keepAliveTimeout = 1000;
  server.requestTimeout = 1000;
  server.headersTimeout = 1000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(1456, "127.0.0.1", resolve);
  });
  try {
    // Bind first: a busy port must not create a new retained setup attempt.
    try {
      await mkdir(path.dirname(directory), { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const store = await createAppRegistrationStore(directory);
    await store.write(
      "session.json",
      Buffer.from(
        JSON.stringify({
          role,
          state,
          deadline,
          manifest: prepareHostedReleaseAppManifest(role),
          production: "held",
          automatic_retry: false,
        }),
      ),
    );
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    await new Promise<void>((resolve) => {
      const finish = async (
        result: Awaited<ReturnType<ReturnType<typeof createAppRegistrationCapture>>> | null,
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // This record has only fixed/public data, even on partial conversion.
        try {
          await store.write(
            "terminal.json",
            Buffer.from(
              JSON.stringify({
                completed: result !== null,
                automatic_retry: false,
                retained: true,
              }),
            ),
          );
          process.stdout.write(
            `${JSON.stringify(result ?? { status: "stopped", role, retained: true, effects: "unresolved", automatic_retry: false })}\n`,
          );
          if (!result) process.exitCode = 1;
        } catch {
          process.exitCode = 1;
          process.stderr.write(
            "Private terminal retention failed; preserve pending setup and use readback.\n",
          );
        } finally {
          resolve();
        }
      };
      const handler = createAppRegistrationHandler({
        role,
        state,
        capture: createAppRegistrationCapture({ role, state, deadline, store }),
        recordBegin: () =>
          store.write(
            "registration-intent.json",
            Buffer.from(
              JSON.stringify({
                role,
                phase: "pending",
                effect: "unresolved",
                deadline,
                automatic_retry: false,
              }),
            ),
          ),
        finish,
      });
      const pending = new Set<Promise<void>>();
      server.on("request", (request, response) => {
        const work = handler(request, response).catch(() => {
          process.exitCode = 1;
          return finish(null);
        });
        pending.add(work);
        void work.finally(() => pending.delete(work));
      });
      timer = setTimeout(
        () => {
          // Retain any response already in flight before terminal readback.
          // The original fetch deadline aborts transport; no new work starts.
          server.closeAllConnections();
          server.close();
          void Promise.allSettled([...pending]).then(() => finish(null));
        },
        Math.max(1, deadline - Date.now()),
      );
      process.stdout.write(
        `${JSON.stringify({ status: "awaiting-github", role, url: `${origin}/portcove-app-setup/${role}/begin`, production: "held", automatic_retry: false })}\n`,
      );
    });
  } finally {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
    process.stderr.write(
      "App registration stopped. Preserve the retained attempt and use readback; no automatic retry.\n",
    );
  });
}
