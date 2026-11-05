import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { retainNativeSourceDeclarations } from "./release-native-source-provider.mts";
import {
  nativeCompatibilitySourcePaths,
  nativeSourceDeclarationByteLimit,
} from "./release-native-source-contract.mts";

async function provider() {
  const responses = new Map(
    await Promise.all(
      nativeCompatibilitySourcePaths.map(async (pathname) => {
        const bytes = await readFile(new URL(`../${pathname}`, import.meta.url));
        return [
          pathname,
          {
            type: "file",
            path: pathname,
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
            sha: createHash("sha1")
              .update(Buffer.from(`blob ${bytes.length}\0`))
              .update(bytes)
              .digest("hex"),
          },
        ] satisfies [
          typeof pathname,
          {
            type: string;
            path: string;
            encoding: string;
            size: number;
            content: string;
            sha: string;
          },
        ];
      }),
    ),
  );
  return async (pathname: (typeof nativeCompatibilitySourcePaths)[number]) =>
    structuredClone(responses.get(pathname)!);
}

void test("provider source reads retain the exact four immutable inputs and refuse changed custody", async (t) => {
  const directory = disposableDirectory(t, path.join(os.tmpdir(), "native-source-provider-"));
  const read = await provider(),
    seen: string[] = [];
  const result = await retainNativeSourceDeclarations(directory, async (pathname) => {
    seen.push(pathname);
    return read(pathname);
  });
  assert.deepEqual(seen, nativeCompatibilitySourcePaths);
  for (const [index, pathname] of nativeCompatibilitySourcePaths.entries())
    assert.deepEqual(
      await readFile(path.join(directory, `native-source-${index}.bin`)),
      await readFile(new URL(`../${pathname}`, import.meta.url)),
    );
  assert.deepEqual(await retainNativeSourceDeclarations(directory, read), result);
  await writeFile(path.join(directory, "native-source-0.bin"), "changed retained bytes");
  await assert.rejects(
    retainNativeSourceDeclarations(directory, read),
    /retained source declaration changed/u,
  );
});

void test("wrong path, size, blob identity, encoding and unavailable provider cannot supply declarations", async (t) => {
  const read = await provider();
  for (const fault of ["path", "size", "sha", "encoding", "content", "unavailable"] as const) {
    const directory = disposableDirectory(t, path.join(os.tmpdir(), "native-source-refusal-"));
    await assert.rejects(
      retainNativeSourceDeclarations(directory, async (pathname) => {
        const response = await read(pathname);
        switch (fault) {
          case "path":
            response.path = "foreign/path" as typeof response.path;
            break;
          case "size":
            response.size++;
            break;
          case "sha":
            response.sha = "0".repeat(40);
            break;
          case "encoding":
            response.encoding = "utf8";
            break;
          case "content":
            response.content = "!";
            break;
          case "unavailable":
            return undefined;
        }
        return response;
      }),
    );
  }
});

void test("non-inline contents resolve only their exact immutable blob within the file budget", async (t) => {
  const read = await provider();
  const pathname = nativeCompatibilitySourcePaths[2];
  const original = await read(pathname);
  const metadata = { ...original, encoding: "none", content: "" };
  const blob = {
    sha: original.sha,
    size: original.size,
    encoding: "base64",
    content: original.content,
  };
  const contents = async (name: (typeof nativeCompatibilitySourcePaths)[number]) =>
    name === pathname ? structuredClone(metadata) : read(name);
  const directory = disposableDirectory(t, path.join(os.tmpdir(), "native-source-blob-"));
  const requested: string[] = [];
  const result = await retainNativeSourceDeclarations(directory, contents, async (sha) => {
    requested.push(sha);
    return structuredClone(blob);
  });
  assert.deepEqual(requested, [original.sha]);
  assert.equal(result.files.find((file) => file.path === pathname)?.bytes, original.size);
  assert.deepEqual(
    await readFile(path.join(directory, "native-source-2.bin")),
    Buffer.from(original.content, "base64"),
  );
  assert.equal(result.authority, "none");
  for (const fault of [
    "missing",
    "unavailable",
    "sha",
    "size",
    "encoding",
    "content",
    "oversized",
  ] as const) {
    const target = disposableDirectory(t, path.join(os.tmpdir(), "native-source-blob-refusal-"));
    const changed = structuredClone(blob);
    switch (fault) {
      case "missing":
        break;

      case "sha":
        changed.sha = "0".repeat(40);
        break;
      case "size":
        changed.size++;
        break;
      case "encoding":
        changed.encoding = "utf8";
        break;
      case "content":
        changed.content = "!";
        break;
      case "oversized":
        changed.content = "A".repeat(2 * nativeSourceDeclarationByteLimit(pathname) + 1);
        break;
    }
    await assert.rejects(
      retainNativeSourceDeclarations(
        target,
        contents,
        fault === "missing"
          ? undefined
          : async () => (fault === "unavailable" ? undefined : changed),
      ),
    );
  }
  const oversized = structuredClone(metadata);
  oversized.size = nativeSourceDeclarationByteLimit(pathname) + 1;
  let blobReads = 0;
  await assert.rejects(
    retainNativeSourceDeclarations(
      disposableDirectory(t, path.join(os.tmpdir(), "native-source-blob-size-")),
      async (name) => (name === pathname ? oversized : read(name)),
      async () => {
        blobReads++;
        return blob;
      },
    ),
  );
  assert.equal(blobReads, 0, "oversized metadata refuses before another source read");
});
