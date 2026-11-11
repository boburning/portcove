import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type AcceptedArtifact,
  type PreservationScope,
  type PreservationStore,
  FileSystemPreservationStore,
  backfill,
  capture,
  exportInventory,
  objectKey,
  restoreInventory,
  scopeKey,
} from "./artifact-preservation.mts";

const bytes = Buffer.from("accepted release artifact bytes");
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const artifact: AcceptedArtifact = {
  port_id: "example-port",
  platform: "windows-x86_64",
  repository: "example/upstream",
  release_id: 11,
  asset_id: 22,
  tag: "v1.0.0",
  commit_sha1: "a".repeat(40),
  filename: "example-windows.zip",
  size: bytes.length,
  sha256: sha256(bytes),
  original_url: "https://github.com/example/upstream/releases/download/v1.0.0/example-windows.zip",
  distribution_basis: "upstream-license-redistribution",
  protected_acceptance: "https://github.com/boburning/portcove/issues/1306",
};
const scope: PreservationScope = {
  artifacts: new Set([scopeKey(artifact)]),
  distribution_bases: new Set(["upstream-license-redistribution"]),
};
const now = () => new Date("2026-11-11T00:00:00Z");
async function* stream(value: Buffer, parts = 3) {
  const step = Math.ceil(value.length / parts);
  for (let offset = 0; offset < value.length; offset += step)
    yield value.subarray(offset, offset + step);
}

async function withStore(run: (store: FileSystemPreservationStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-preservation-"));
  try {
    await run(new FileSystemPreservationStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test("captures an eligible artifact and verifies it by a separate read-back", async () => {
  await withStore(async (store) => {
    const record = await capture({
      artifact,
      scope,
      store,
      now,
      fetchOriginal: () => stream(bytes),
    });
    assert.equal(record.state, "verified");
    assert.equal(record.object_key, `${artifact.sha256}.asset`);
    assert.equal(record.verified_at, "2026-11-11T00:00:00.000Z");
    assert.deepEqual(await store.keys(), [objectKey(artifact)]);
  });
});

void test("refuses artifacts outside the declared scope or distribution basis without fetching", async () => {
  await withStore(async (store) => {
    const fetchOriginal = () => {
      throw new Error("must not fetch");
    };
    const outside = await capture({
      artifact: { ...artifact, asset_id: 99 },
      scope,
      store,
      now,
      fetchOriginal,
    });
    assert.equal(outside.state, "ineligible");
    const basis = await capture({
      artifact: { ...artifact, distribution_basis: "unknown" },
      scope: { ...scope, distribution_bases: new Set() },
      store,
      now,
      fetchOriginal,
    });
    assert.equal(basis.state, "ineligible");
    assert.deepEqual(await store.keys(), []);
  });
});

void test("replay is idempotent and verifies the existing object without another transfer", async () => {
  await withStore(async (store) => {
    await capture({ artifact, scope, store, now, fetchOriginal: () => stream(bytes) });
    let fetched = false;
    const replay = await capture({
      artifact,
      scope,
      store,
      now,
      fetchOriginal: () => {
        fetched = true;
        return stream(bytes);
      },
    });
    assert.equal(replay.state, "verified");
    assert.equal(fetched, false);
  });
});

void test("different, oversized or interrupted original bytes are never published", async () => {
  await withStore(async (store) => {
    const changed = Buffer.from("different bytes of the same size!!".slice(0, bytes.length));
    const differs = await capture({
      artifact,
      scope,
      store,
      now,
      fetchOriginal: () => stream(changed),
    });
    assert.equal(differs.state, "failed");
    assert.match(differs.reason ?? "", /differ from the accepted/u);
    const oversized = await capture({
      artifact,
      scope,
      store,
      now,
      fetchOriginal: () => stream(Buffer.concat([bytes, Buffer.from("x")])),
    });
    assert.equal(oversized.state, "failed");
    assert.match(oversized.reason ?? "", /exceeds the accepted size/u);
    const interrupted = await capture({
      artifact,
      scope,
      store,
      now,
      fetchOriginal: async function* () {
        yield bytes.subarray(0, 4);
        throw new Error("connection reset");
      },
    });
    assert.equal(interrupted.state, "failed");
    assert.match(interrupted.reason ?? "", /connection reset/u);
    assert.deepEqual(await store.keys(), []);
  });
});

void test("stored corruption fails verification and is preserved, not overwritten", async () => {
  await withStore(async (store, root) => {
    await writeFile(path.join(root, objectKey(artifact)), Buffer.alloc(bytes.length, 1));
    const record = await capture({
      artifact,
      scope,
      store,
      now,
      fetchOriginal: () => stream(bytes),
    });
    assert.equal(record.state, "failed");
    assert.match(record.reason ?? "", /stored object differs/u);
  });
});

void test("a read-back mismatch after a successful upload is not verified", async () => {
  const objects = new Map<string, Buffer>();
  const lying: PreservationStore = {
    exists: async (key) => objects.has(key),
    stage: async (chunks) => {
      const parts: Buffer[] = [];
      for await (const chunk of chunks) parts.push(Buffer.from(chunk));
      objects.set("staged", Buffer.concat(parts));
      return "staged";
    },
    publish: async (staged, key) => {
      objects.set(key, Buffer.alloc(objects.get(staged)!.length, 7));
      objects.delete(staged);
    },
    discard: async (staged) => void objects.delete(staged),
    read: (key) => stream(objects.get(key) ?? Buffer.alloc(0)),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  };
  const record = await capture({
    artifact,
    scope,
    store: lying,
    now,
    fetchOriginal: () => stream(bytes),
  });
  assert.equal(record.state, "failed");
  assert.equal(exportInventory([record]).inventory.records.length, 0);
});

void test("capacity exhaustion defers capture as pending without eviction", async () => {
  await withStore(async (store) => {
    const full: PreservationStore = {
      exists: (key) => store.exists(key),
      stage: (chunks) => store.stage(chunks),
      publish: (staged, key) => store.publish(staged, key),
      discard: (staged) => store.discard(staged),
      read: (key) => store.read(key),
      availableBytes: async () => bytes.length - 1,
    };
    const record = await capture({
      artifact,
      scope,
      store: full,
      now,
      fetchOriginal: () => {
        throw new Error("must not fetch");
      },
    });
    assert.equal(record.state, "pending");
    assert.match(record.reason ?? "", /capacity is exhausted/u);
    const enospc: PreservationStore = {
      ...full,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      stage: async () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    };
    const during = await capture({
      artifact,
      scope,
      store: enospc,
      now,
      fetchOriginal: () => stream(bytes),
    });
    assert.equal(during.state, "pending");
    assert.deepEqual(await store.keys(), []);
  });
});

void test("a storage error is recorded per artifact and does not abort backfill", async () => {
  await withStore(async (store) => {
    const otherBytes = Buffer.from("other accepted release bytes");
    const broken: AcceptedArtifact = {
      ...artifact,
      asset_id: 30,
      size: otherBytes.length,
      sha256: sha256(otherBytes),
    };
    const failing: PreservationStore = {
      exists: async (key) => {
        if (key === objectKey(broken)) throw new Error("not a regular file");
        return store.exists(key);
      },
      stage: (chunks) => store.stage(chunks),
      publish: (staged, key) => store.publish(staged, key),
      discard: (staged) => store.discard(staged),
      read: (key) => store.read(key),
      availableBytes: () => store.availableBytes(),
    };
    const records = await backfill([broken, artifact], {
      scope: { ...scope, artifacts: new Set([scopeKey(broken), scopeKey(artifact)]) },
      store: failing,
      now,
      fetchOriginal: (item) => stream(item.asset_id === broken.asset_id ? otherBytes : bytes),
    });
    assert.deepEqual(
      records.map((record) => record.state),
      ["failed", "verified"],
    );
    assert.match(records[0]?.reason ?? "", /not a regular file/u);
  });
});

void test("ambiguous scope identities are rejected", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      capture({
        artifact: { ...artifact, port_id: "a:b" },
        scope,
        store,
        now,
        fetchOriginal: () => stream(bytes),
      }),
      /port_id is invalid/u,
    );
  });
});

void test("finite backfill, inventory export and verified restore preserve identity", async () => {
  await withStore(async (source) => {
    const other = { ...artifact, asset_id: 23, port_id: "outside-scope" };
    const records = await backfill([artifact, other], {
      scope,
      store: source,
      now,
      fetchOriginal: () => stream(bytes),
    });
    assert.deepEqual(
      records.map((record) => record.state),
      ["verified", "ineligible"],
    );
    const { inventory, sha256: manifest } = exportInventory(records);
    assert.equal(inventory.records.length, 1);
    assert.match(manifest, /^[a-f0-9]{64}$/u);
    await withStore(async (target) => {
      const restored = await restoreInventory(inventory, source, target);
      assert.deepEqual(restored, [
        { object_key: objectKey(artifact), restored: true, reason: null },
      ]);
      assert.deepEqual(await target.keys(), [objectKey(artifact)]);
    });
  });
});

void test("restore reports a corrupted source object and does not copy it", async () => {
  await withStore(async (source, root) => {
    await capture({ artifact, scope, store: source, now, fetchOriginal: () => stream(bytes) });
    const { inventory } = exportInventory([
      {
        artifact,
        object_key: objectKey(artifact),
        state: "verified",
        reason: null,
        recorded_at: "",
        verified_at: "",
      },
    ]);
    await rm(path.join(root, objectKey(artifact)));
    await writeFile(path.join(root, objectKey(artifact)), Buffer.alloc(bytes.length, 9));
    await withStore(async (target) => {
      const [result] = await restoreInventory(inventory, source, target);
      assert.equal(result?.restored, false);
      assert.deepEqual(await target.keys(), []);
    });
  });
});

void test("malformed accepted identity is rejected before storage access", async () => {
  await withStore(async (store) => {
    for (const bad of [
      { ...artifact, size: 0 },
      { ...artifact, sha256: "A".repeat(64) },
      { ...artifact, filename: "../escape.zip" },
      { ...artifact, original_url: "http://example.com/a.zip" },
    ])
      await assert.rejects(
        capture({ artifact: bad, scope, store, now, fetchOriginal: () => stream(bytes) }),
      );
    assert.deepEqual(await store.keys(), []);
  });
});

void test("concurrent captures publish one object and both verify it", async () => {
  await withStore(async (store, root) => {
    const records = await Promise.all(
      [0, 1].map(() =>
        capture({ artifact, scope, store, now, fetchOriginal: () => stream(bytes, 8) }),
      ),
    );
    assert.deepEqual(
      records.map((record) => record.state),
      ["verified", "verified"],
    );
    assert.deepEqual(await readdir(root), [objectKey(artifact)]);
  });
});

void test("restore never publishes source bytes that change after selection", async () => {
  await withStore(async (source) => {
    await capture({ artifact, scope, store: source, now, fetchOriginal: () => stream(bytes) });
    const { inventory } = exportInventory([
      {
        artifact,
        object_key: objectKey(artifact),
        state: "verified",
        reason: null,
        recorded_at: "",
        verified_at: "",
      },
    ]);
    const changing: PreservationStore = {
      exists: (key) => source.exists(key),
      stage: (chunks) => source.stage(chunks),
      publish: (staged, key) => source.publish(staged, key),
      discard: (staged) => source.discard(staged),
      read: () => stream(Buffer.concat([bytes, Buffer.from("grown")])),
      availableBytes: () => source.availableBytes(),
    };
    await withStore(async (target, root) => {
      const [result] = await restoreInventory(inventory, changing, target);
      assert.equal(result?.restored, false);
      assert.deepEqual(await readdir(root), []);
    });
  });
});

void test("inventory digest is independent of record field order and duplicates", () => {
  const verified = {
    artifact,
    object_key: objectKey(artifact),
    state: "verified" as const,
    reason: null,
    recorded_at: "",
    verified_at: "",
  };
  const reordered = Object.fromEntries(Object.entries(artifact).reverse()) as typeof artifact;
  const first = exportInventory([verified]);
  const second = exportInventory([{ ...verified, artifact: reordered }, verified]);
  assert.equal(first.sha256, second.sha256);
  assert.equal(second.inventory.records.length, 1);
});
