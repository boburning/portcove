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
            status: 200,
            body: {
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
          },
        ] satisfies [
          typeof pathname,
          {
            status: number;
            body: {
              type: string;
              path: string;
              encoding: string;
              size: number;
              content: string;
              sha: string;
            };
          },
        ];
      }),
    ),
  );
  return (pathname: (typeof nativeCompatibilitySourcePaths)[number]) =>
    structuredClone(responses.get(pathname)!);
}

void test("provider source reads retain the exact four immutable inputs and refuse changed custody", async (t) => {
  const directory = disposableDirectory(t, path.join(os.tmpdir(), "native-source-provider-"));
  const read = await provider(),
    seen: string[] = [];
  const result = await retainNativeSourceDeclarations(directory, (pathname) => {
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
  for (const fault of ["path", "size", "sha", "encoding", "content", "status"] as const) {
    const directory = disposableDirectory(t, path.join(os.tmpdir(), "native-source-refusal-"));
    await assert.rejects(
      retainNativeSourceDeclarations(directory, (pathname) => {
        const response = read(pathname);
        switch (fault) {
          case "path":
            response.body.path = "foreign/path" as typeof response.body.path;
            break;
          case "size":
            response.body.size++;
            break;
          case "sha":
            response.body.sha = "0".repeat(40);
            break;
          case "encoding":
            response.body.encoding = "utf8";
            break;
          case "content":
            response.body.content = "!";
            break;
          case "status":
            response.status = 404;
            break;
        }
        return response;
      }),
    );
  }
});

void test("non-inline contents resolve only their exact immutable blob within the file budget", async (t) => {
  const read = await provider();
  const pathname = nativeCompatibilitySourcePaths[2];
  const original = read(pathname);
  const metadata = {
    ...original,
    body: { ...original.body, encoding: "none", content: "" },
  };
  const blob = {
    status: 200,
    body: {
      sha: original.body.sha,
      size: original.body.size,
      encoding: "base64",
      content: original.body.content,
    },
  };
  const contents = (name: (typeof nativeCompatibilitySourcePaths)[number]) =>
    name === pathname ? structuredClone(metadata) : read(name);
  const directory = disposableDirectory(t, path.join(os.tmpdir(), "native-source-blob-"));
  const requested: string[] = [];
  const result = await retainNativeSourceDeclarations(directory, contents, (sha) => {
    requested.push(sha);
    return structuredClone(blob);
  });
  assert.deepEqual(requested, [original.body.sha]);
  assert.equal(result.files.find((file) => file.path === pathname)?.bytes, original.body.size);
  assert.deepEqual(
    await readFile(path.join(directory, "native-source-2.bin")),
    Buffer.from(original.body.content, "base64"),
  );
  assert.equal(result.authority, "none");
  for (const fault of [
    "missing",
    "status",
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
      case "status":
        changed.status = 404;
        break;
      case "sha":
        changed.body.sha = "0".repeat(40);
        break;
      case "size":
        changed.body.size++;
        break;
      case "encoding":
        changed.body.encoding = "utf8";
        break;
      case "content":
        changed.body.content = "!";
        break;
      case "oversized":
        changed.body.content = "A".repeat(2 * nativeSourceDeclarationByteLimit(pathname) + 1);
        break;
    }
    await assert.rejects(
      retainNativeSourceDeclarations(
        target,
        contents,
        fault === "missing" ? undefined : () => changed,
      ),
    );
  }
  const oversized = structuredClone(metadata);
  oversized.body.size = nativeSourceDeclarationByteLimit(pathname) + 1;
  let blobReads = 0;
  await assert.rejects(
    retainNativeSourceDeclarations(
      disposableDirectory(t, path.join(os.tmpdir(), "native-source-blob-size-")),
      (name) => (name === pathname ? oversized : read(name)),
      () => {
        blobReads++;
        return blob;
      },
    ),
  );
  assert.equal(blobReads, 0, "oversized metadata refuses before another source read");
});
