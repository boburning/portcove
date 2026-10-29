import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

/** Host-level counts cannot attribute a CONNECT request to a selected image. */
export function assertCachedCoverTraffic(origins: readonly string[], explicitScope: boolean) {
  const count = origins.filter((origin) => origin === "images.igdb.com").length;
  if (!explicitScope)
    assert.equal(count, 0, "All mapped cached covers render after restart without an IGDB request");
  return count;
}

export function assertDefaultCoverPresentation(image: {
  background: string;
  identitySurface: boolean;
  surfaceBackground: string;
  objectFit: string;
  fallbackPalette: boolean;
}) {
  if (image.identitySurface)
    assert.ok(image.surfaceBackground, "Identity surface token is present");
  assert.equal(
    image.background,
    image.identitySurface ? image.surfaceBackground : "rgba(0, 0, 0, 0)",
    "Artwork matte follows its surface",
  );
  assert.equal(image.objectFit, "contain", "The complete original cover remains visible");
  assert.equal(image.fallbackPalette, false, "Real images do not inherit placeholder colors");
}

/** Select observation scope only; Core's accepted catalog still owns mappings. */
export function selectDefaultCoverIds(
  ports: readonly { id: string; presentation?: { artwork?: unknown } | null }[],
  requested: readonly string[] = [],
  cacheConditions = false,
) {
  const mapped = ports.filter((port) => port.presentation?.artwork).map((port) => port.id);
  if (requested.length > 16 || new Set(requested).size !== requested.length)
    throw new Error("Choose at most 16 unique --cover-port-id values");
  for (const id of requested)
    if (!mapped.includes(id))
      throw new Error(`Cover observation requires an accepted mapping: ${id}`);
  const ids = requested.length ? [...requested] : mapped;
  if (!ids.length) throw new Error("The actual catalog must have accepted cover mappings");
  if (cacheConditions && !ids.includes("dkr-r"))
    throw new Error("Cache observations require dkr-r for the maintained missing-cache control");
  return ids;
}
import { errorMessage } from "../../../scripts/runtime-values.mts";

export interface WithheldCover {
  original: string;
  retained: string;
}

export async function createImageRefusal() {
  const origins: string[] = [];
  const sockets = new Set<Socket>();
  // Test-only local refusal: never forwards traffic or records headers, paths or credentials.
  const server = createServer((request, response) => {
    origins.push("http-request");
    response.writeHead(503).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(2000, () => socket.destroy());
  });
  server.on("connect", (request, socket) => {
    origins.push(request.url === "images.igdb.com:443" ? "images.igdb.com" : "other-origin");
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const proxy = `http://127.0.0.1:${address.port}`;
  return {
    origins,
    environment: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function restoreCacheAfterObservation({
  withheld,
  restart,
  primaryFailure,
  output,
  artifacts,
  refusal,
}: {
  withheld: WithheldCover | undefined;
  restart: (name: string, prepareWhileStopped?: () => Promise<void>) => Promise<unknown>;
  primaryFailure: { error: unknown } | undefined;
  output: string;
  artifacts: string[];
  refusal: Pick<Awaited<ReturnType<typeof createImageRefusal>>, "close"> | null;
}) {
  let cleanupFailure: { error: unknown } | undefined;
  try {
    if (withheld) {
      await restart("default-cover-cache-restored", async () => {
        const bytes = await readFile(withheld.retained);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          path.basename(withheld.original, ".jpg"),
        );
        await rename(withheld.retained, withheld.original);
      });
    }
  } catch (error) {
    cleanupFailure = { error };
  }
  try {
    await refusal?.close();
  } catch (error) {
    cleanupFailure ??= { error };
  }
  if (!cleanupFailure) return;
  if (!primaryFailure) throw cleanupFailure.error;
  const diagnostic = path.join(output, "default-cover-cache-cleanup-failure.json");
  await writeFile(
    diagnostic,
    JSON.stringify({
      primary: errorMessage(primaryFailure.error),
      cleanup: errorMessage(cleanupFailure.error),
    }),
  )
    .then(() => artifacts.push(diagnostic))
    .catch((error: unknown) =>
      console.error("Failed to retain cache cleanup diagnostic:", errorMessage(error)),
    );
}
