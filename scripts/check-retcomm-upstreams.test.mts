import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type {
  PortDefinition,
  ReleaseSpec,
  DirectReleaseSpec,
} from "../apps/desktop/src/transport-types.generated.d.ts";

// These fixtures inspect only the fields used by the RetComM boundary tests.
// The generated Rust contract owns their field types; this is not catalog admission.
type IndependentFixture = Pick<PortDefinition, "id" | "platforms" | "project_url"> & {
  release: Partial<Pick<ReleaseSpec, "repository">> & {
    direct: { "windows-x86-64": Pick<DirectReleaseSpec, "url" | "sha256" | "size" | "version"> };
  };
};
function independentFixtures(catalog: unknown): IndependentFixture[] {
  assert.ok(isRecord(catalog) && Array.isArray(catalog.ports));
  const ports: unknown[] = catalog.ports;
  const selected = ports.filter(
    (entry) =>
      isRecord(entry) &&
      ["alexbeav-ape-escape-recomp", "alexbeav-alundra-recomp"].includes(String(entry.id)),
  );
  return selected.map((entry) => {
    assertIndependentFixture(entry);
    return entry;
  });
}
function assertIndependentFixture(value: unknown): asserts value is IndependentFixture {
  assert.ok(
    isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.project_url === "string" &&
      Array.isArray(value.platforms) &&
      value.platforms.every((platform: unknown) => typeof platform === "string") &&
      isRecord(value.release) &&
      (value.release.repository === undefined || typeof value.release.repository === "string") &&
      isRecord(value.release.direct),
  );
  const artifact = value.release.direct["windows-x86-64"];
  assert.ok(
    isRecord(artifact) &&
      typeof artifact.url === "string" &&
      typeof artifact.sha256 === "string" &&
      typeof artifact.size === "number" &&
      typeof artifact.version === "string",
  );
}

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture or source section is missing");
  return value;
}

void test("offline RetComM validation rejects bad mappings without loading upstream data", async () => {
  const { mkdtemp, mkdir, writeFile, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "portcove-offline-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "crates/portcove-core/catalog"), {
      recursive: true,
    });
    const checker = join(root, "scripts/check-retcomm-upstreams.mts");
    await copyFile(new URL("./check-retcomm-upstreams.mts", import.meta.url), checker);
    await copyFile(
      new URL("./runtime-values.mts", import.meta.url),
      path.join(root, "scripts/runtime-values.mts"),
    );
    const preload = join(root, "deny-network.mjs");
    await writeFile(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
    const port = {
      id: "fixture",
      adapter: "psx-recomp-managed",
      release: { repository: "owner/game" },
    };
    const catalogFile = join(root, "crates/portcove-core/catalog/catalog.json");
    await writeFile(catalogFile, JSON.stringify({ ports: [port] }));
    const mappingFile = join(root, "scripts/retcomm-psx-upstreams.json");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, checker, ...args], {
        encoding: "utf8",
        env: { ...process.env, RETCOMM_CATALOG_DIR: "" },
      });
    await writeFile(mappingFile, JSON.stringify({ fixture: "fixture-title" }));
    const valid = run("--offline");
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Live upstream checks were not run/);
    const live = run();
    assert.equal(live.status, 1);
    assert.match(live.stderr, /NETWORK_FORBIDDEN/);
    for (const mappings of [{}, { stale: "fixture-title" }]) {
      await writeFile(mappingFile, JSON.stringify(mappings));
      const invalid = run("--offline");
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /missing RetComM title mapping/);
      assert.doesNotMatch(invalid.stderr, /NETWORK_FORBIDDEN/);
    }

    const actualCatalog: unknown = JSON.parse(
      await readFile(
        new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const independent = independentFixtures(actualCatalog);
    assert.equal(independent.length, 2);
    await writeFile(mappingFile, JSON.stringify({ fixture: "fixture-title" }));
    await writeFile(catalogFile, JSON.stringify({ ports: [port, ...independent] }));
    const coexist = run("--offline");
    assert.equal(coexist.status, 0, coexist.stderr);
    assert.match(coexist.stdout, /Checked 1 local PlayStation upstream mapping\./);
    assert.equal(
      requiredFixture(coexist.stdout.match(/RetComM audit NOT_APPLICABLE:/gu)).length,
      2,
    );
    assert.equal(requiredFixture(coexist.stdout.match(/upstream health NOT_CHECKED/gu)).length, 2);
    for (const entry of independent) {
      assert.match(coexist.stdout, new RegExp(entry.id));
      assert.ok(coexist.stdout.includes(entry.release.direct["windows-x86-64"].sha256));
    }
    const direct = structuredClone(requiredFixture(independent[0]));
    direct.id = "independent-fixture"; // Identity semantics, never a title allowlist.
    const invalidCases: {
      name: string;
      ports: unknown[];
      mappings?: Record<string, string>;
      error: RegExp;
    }[] = [
      {
        name: "mapped direct",
        ports: [direct],
        mappings: { [direct.id]: "fixture-title" },
        error: /must resolve directly through GitHub/,
      },
      {
        name: "missing mapping",
        ports: [port],
        mappings: {},
        error: /missing RetComM title mapping/,
      },
      {
        name: "stale mapping",
        ports: [direct],
        mappings: { stale: "fixture-title" },
        error: /stale mapping/,
      },
      {
        name: "invalid mapped provider",
        ports: [{ ...port, release: { provider: "gitlab", repository: "owner/game" } }],
        error: /must resolve directly through GitHub/,
      },
      {
        name: "missing mapped repository",
        ports: [{ ...port, release: {} }],
        error: /missing GitHub game repository identity/,
      },
      {
        name: "launcher substitution",
        ports: [{ ...port, release: { repository: "TechnicallyComputers/RetComM-Launcher" } }],
        error: /instead of the game upstream/,
      },
    ];
    const ambiguous = (name: string, mutate: (entry: IndependentFixture) => void) => {
      const entry = structuredClone(direct);
      mutate(entry);
      invalidCases.push({
        name,
        ports: [port, entry],
        error: /ambiguous independent direct-manifest identity/,
      });
    };
    ambiguous("mapped project disguised", (entry) => {
      entry.project_url = "https://github.com/OWNER/GAME";
    });
    ambiguous("mapped artifact disguised", (entry) => {
      entry.release.direct["windows-x86-64"].url =
        "https://github.com/OWNER/GAME/releases/download/v1/game.zip";
    });
    ambiguous("launcher project", (entry) => {
      entry.project_url = "https://github.com/TechnicallyComputers/RetComM-Launcher";
    });
    ambiguous("RetComM artifact", (entry) => {
      entry.release.direct["windows-x86-64"].url =
        "https://github.com/TechnicallyComputers/retcomm-catalog/releases/download/v1/game.zip";
    });
    ambiguous("fake repository", (entry) => {
      entry.release.repository = "owner/game";
    });
    ambiguous("missing project", (entry) => {
      // @ts-expect-error Deliberately remove a required catalog field at the JSON boundary.
      delete entry.project_url;
    });
    ambiguous("aliased project", (entry) => {
      entry.project_url += "?alias=owner/game";
    });
    ambiguous("git project alias", (entry) => {
      entry.project_url = "https://github.com/owner/game.git";
    });
    ambiguous("empty artifact path component", (entry) => {
      entry.release.direct["windows-x86-64"].url =
        "https://github.com/owner/game/releases/download//game.zip";
    });
    ambiguous("invalid digest", (entry) => {
      entry.release.direct["windows-x86-64"].sha256 = "bad";
    });
    ambiguous("missing platform", (entry) => {
      entry.platforms.push("linux-x86-64");
    });
    ambiguous("invalid size", (entry) => {
      entry.release.direct["windows-x86-64"].size = 0;
    });
    ambiguous("missing version", (entry) => {
      // @ts-expect-error Deliberately remove required artifact metadata.
      delete entry.release.direct["windows-x86-64"].version;
    });
    for (const fixture of invalidCases) {
      await writeFile(catalogFile, JSON.stringify({ ports: fixture.ports }));
      await writeFile(
        mappingFile,
        JSON.stringify(fixture.mappings ?? { fixture: "fixture-title" }),
      );
      const rejected = run("--offline");
      assert.equal(rejected.status, 1, fixture.name);
      assert.match(rejected.stderr, fixture.error, fixture.name);
      assert.doesNotMatch(rejected.stderr, /TypeError|NETWORK_FORBIDDEN/, fixture.name);
      assert.doesNotMatch(
        rejected.stdout,
        /Checked \d+ (?:local|direct) PlayStation/u,
        fixture.name,
      );
    }
    await writeFile(catalogFile, JSON.stringify({ ports: [port, direct] }));
    await writeFile(mappingFile, JSON.stringify({ fixture: "fixture-title" }));
    const renamed = run("--offline");
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.match(renamed.stdout, /independent-fixture/);
    assert.match(renamed.stdout, /Checked 1 local PlayStation upstream mapping\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RetComM remote manifests fall back only after 404 and retain access failures", async () => {
  const { copyFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-retcomm-remote-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
    const checker = path.join(root, "scripts/check-retcomm-upstreams.mts");
    await copyFile(new URL("./check-retcomm-upstreams.mts", import.meta.url), checker);
    await copyFile(
      new URL("./runtime-values.mts", import.meta.url),
      path.join(root, "scripts/runtime-values.mts"),
    );
    const independent = independentFixtures(
      JSON.parse(
        await readFile(
          new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    assert.equal(independent.length, 2);
    await writeFile(
      path.join(root, "crates/portcove-core/catalog/catalog.json"),
      JSON.stringify({
        ports: [
          { id: "fixture", adapter: "psx-recomp-managed", release: { repository: "owner/game" } },
          ...independent,
        ],
      }),
    );
    await writeFile(
      path.join(root, "scripts/retcomm-psx-upstreams.json"),
      JSON.stringify({ fixture: "fixture-title" }),
    );
    const preload = path.join(root, "fixture-fetch.mjs");
    const requestsFile = path.join(root, "requests.json");
    await writeFile(
      preload,
      `import { writeFileSync } from "node:fs";
const replies = JSON.parse(process.env.RETCOMM_FIXTURE_REPLIES);
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, headers: options.headers });
  writeFileSync(process.env.RETCOMM_FIXTURE_REQUESTS, JSON.stringify(requests));
  const reply = replies[requests.length - 1];
  if (!reply) throw new Error("UNEXPECTED_NETWORK_REQUEST");
  if (reply.error) throw new Error(reply.error);
  return new Response(reply.body, { status: reply.status });
};`,
    );
    const valid = { status: 200, body: JSON.stringify({ release: { github: "owner/game" } }) };
    const missing = { status: 404, body: "missing" };
    const cases = [
      { name: "platform precedence", replies: [valid], status: 0, requests: 1 },
      { name: "legacy fallback", replies: [missing, valid], status: 0, requests: 2 },
      {
        name: "both missing",
        replies: [missing, missing],
        status: 1,
        requests: 2,
        error: /returned 404/,
      },
      {
        name: "forbidden",
        replies: [{ status: 403, body: "private" }, valid],
        status: 1,
        requests: 1,
        error: /returned 403/,
      },
      {
        name: "server failure",
        replies: [{ status: 503, body: "unavailable" }, valid],
        status: 1,
        requests: 1,
        error: /returned 503/,
      },
      {
        name: "transport failure",
        replies: [{ error: "FIXTURE_ACCESS_FAILURE" }, valid],
        status: 1,
        requests: 1,
        error: /FIXTURE_ACCESS_FAILURE/,
      },
      {
        name: "invalid platform JSON",
        replies: [{ status: 200, body: "{" }, valid],
        status: 1,
        requests: 1,
        error: /fixture:/,
      },
      {
        name: "invalid legacy JSON",
        replies: [missing, { status: 200, body: "{" }],
        status: 1,
        requests: 2,
        error: /fixture:/,
      },
      {
        name: "missing repository",
        replies: [{ status: 200, body: "{}" }, valid],
        status: 1,
        requests: 1,
        error: /no GitHub game release repository/,
      },
      {
        name: "conflicting source",
        replies: [
          {
            status: 200,
            body: JSON.stringify({
              release: { github: "owner/game" },
              build: { source: { github: "other/game" } },
            }),
          },
        ],
        status: 1,
        requests: 1,
        error: /repositories differ/,
      },
    ];
    const urls = [
      "https://raw.githubusercontent.com/TechnicallyComputers/retcomm-catalog/fixture%2Fref/titles/psx/fixture-title.json",
      "https://raw.githubusercontent.com/TechnicallyComputers/retcomm-catalog/fixture%2Fref/titles/fixture-title.json",
    ];
    for (const fixture of cases) {
      await writeFile(requestsFile, "[]");
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, checker],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            RETCOMM_CATALOG_DIR: "",
            RETCOMM_CATALOG_REF: "fixture/ref",
            RETCOMM_FIXTURE_REPLIES: JSON.stringify(fixture.replies),
            RETCOMM_FIXTURE_REQUESTS: requestsFile,
          },
        },
      );
      assert.equal(result.status, fixture.status, `${fixture.name}: ${result.stderr}`);
      const requestData: unknown = JSON.parse(await readFile(requestsFile, "utf8"));
      assert.ok(Array.isArray(requestData));
      const requestValues: unknown[] = requestData;
      const requests = requestValues.map((request) => {
        assert.ok(
          isRecord(request) && typeof request.url === "string" && isRecord(request.headers),
        );
        return { url: request.url, headers: request.headers };
      });
      assert.deepEqual(
        requests.map((request) => request.url),
        urls.slice(0, fixture.requests),
        fixture.name,
      );
      for (const request of requests) {
        assert.deepEqual(request.headers, { "User-Agent": "Portcove-RetComM-upstream-audit" });
      }
      if (fixture.error) {
        assert.match(result.stderr, fixture.error, fixture.name);
        assert.doesNotMatch(result.stdout, /Checked \d+ direct PlayStation/u);
      } else {
        assert.match(result.stdout, /Checked 1 direct PlayStation upstream repository/);
        assert.equal(
          requiredFixture(result.stdout.match(/RetComM audit NOT_APPLICABLE:/gu)).length,
          2,
        );
        assert.equal(
          requiredFixture(result.stdout.match(/upstream health NOT_CHECKED/gu)).length,
          2,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("upstream summaries report zero, one, and many selected repositories without overstating scope", async (t) => {
  const { copyFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-upstream-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  const script = path.join(root, "scripts/check-retcomm-upstreams.mts");
  await copyFile(new URL("./check-retcomm-upstreams.mts", import.meta.url), script);
  await copyFile(
    new URL("./runtime-values.mts", import.meta.url),
    path.join(root, "scripts/runtime-values.mts"),
  );
  const catalog = path.join(root, "crates/portcove-core/catalog");
  const upstream = path.join(root, "upstream");
  await mkdir(catalog, { recursive: true });
  await mkdir(path.join(upstream, "titles/psx"), { recursive: true });
  const ports = ["first", "second", "same-repository"].map((id) => ({
    id,
    adapter: "psx-recomp-managed",
    release: { repository: `owner/${id === "same-repository" ? "first" : id}` },
  }));
  await writeFile(path.join(catalog, "catalog.json"), JSON.stringify({ ports }));
  await writeFile(
    path.join(root, "scripts/retcomm-psx-upstreams.json"),
    JSON.stringify(Object.fromEntries(ports.map((port) => [port.id, port.id]))),
  );
  for (const port of ports)
    await writeFile(
      path.join(upstream, "titles/psx", `${port.id}.json`),
      JSON.stringify({ release: { github: port.release.repository } }),
    );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, RETCOMM_CATALOG_DIR: upstream },
    });
  for (const [selection, expected] of [
    ["", "0 direct PlayStation upstream repositories for 0 mapped ports"],
    ["first", "1 direct PlayStation upstream repository for 1 mapped port"],
    [
      "first,second,same-repository",
      "2 direct PlayStation upstream repositories for 3 mapped ports",
    ],
  ]) {
    const result = run(`--port-ids=${selection}`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Checked ${expected} against ${upstream}.`), result.stdout);
    assert.match(result.stdout, /RetComM-Launcher is not used as a release source\./u);
    assert.match(result.stdout, /Unselected live identities remain unassessed\./u);
  }
  for (const count of [0, 1, 2]) {
    const subset = ports.slice(0, count);
    await writeFile(path.join(catalog, "catalog.json"), JSON.stringify({ ports: subset }));
    await writeFile(
      path.join(root, "scripts/retcomm-psx-upstreams.json"),
      JSON.stringify(Object.fromEntries(subset.map((port) => [port.id, port.id]))),
    );
    const result = run("--offline");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes(
        `Checked ${count} local PlayStation upstream mapping${count === 1 ? "" : "s"}.`,
      ),
    );
    assert.match(result.stdout, /Live upstream checks were not run\./u);
  }
  await rm(path.join(upstream, "titles/psx/first.json"));
  const unavailable = run("--port-ids=first");
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /no PSX title manifest/u);
  assert.doesNotMatch(unavailable.stdout, /Checked/u);
});

void test("RetComM scoped live reads exclude unrelated manifests without narrowing offline validation", async () => {
  const { copyFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-retcomm-scoped-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
    const checker = path.join(root, "scripts/check-retcomm-upstreams.mts");
    await copyFile(new URL("./check-retcomm-upstreams.mts", import.meta.url), checker);
    await copyFile(
      new URL("./runtime-values.mts", import.meta.url),
      path.join(root, "scripts/runtime-values.mts"),
    );
    await writeFile(
      path.join(root, "crates/portcove-core/catalog/catalog.json"),
      JSON.stringify({
        ports: ["selected", "unselected"].map((id) => ({
          id,
          adapter: "psx-recomp-managed",
          release: { repository: `owner/${id}` },
        })),
      }),
    );
    await writeFile(
      path.join(root, "scripts/retcomm-psx-upstreams.json"),
      JSON.stringify({ selected: "selected-title", unselected: "unselected-title" }),
    );
    const upstream = path.join(root, "upstream");
    await mkdir(path.join(upstream, "titles/psx"), { recursive: true });
    await writeFile(
      path.join(upstream, "titles/psx/selected-title.json"),
      JSON.stringify({ release: { github: "owner/selected" } }),
    );
    const preload = path.join(root, "deny-network.mjs");
    await writeFile(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, checker, ...args], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, RETCOMM_CATALOG_DIR: upstream },
      });
    const scoped = run("--port-ids=selected");
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /Checked 1 direct PlayStation upstream repository/);
    assert.match(scoped.stdout, /Unselected live identities remain unassessed/);
    const full = run();
    assert.equal(full.status, 1);
    assert.match(full.stderr, /unselected/);
    assert.equal(run("--offline").status, 0);
    for (const args of [
      ["--offline", "--port-ids=selected"],
      ["--port-ids=missing"],
      ["--port-ids=selected,,unselected"],
      ["--port-ids=selected,selected"],
    ])
      assert.equal(run(...args).status, 1, JSON.stringify(args));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RetComM local manifests preserve platform precedence and refuse malformed paths", async () => {
  const { copyFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-retcomm-local-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
    const checker = path.join(root, "scripts/check-retcomm-upstreams.mts");
    await copyFile(new URL("./check-retcomm-upstreams.mts", import.meta.url), checker);
    await copyFile(
      new URL("./runtime-values.mts", import.meta.url),
      path.join(root, "scripts/runtime-values.mts"),
    );
    await writeFile(
      path.join(root, "crates/portcove-core/catalog/catalog.json"),
      JSON.stringify({
        ports: [
          { id: "fixture", adapter: "psx-recomp-managed", release: { repository: "owner/game" } },
        ],
      }),
    );
    await writeFile(
      path.join(root, "scripts/retcomm-psx-upstreams.json"),
      JSON.stringify({ fixture: "fixture-title" }),
    );
    const preload = path.join(root, "deny-network.mjs");
    await writeFile(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };');
    const upstream = path.join(root, "upstream");
    await mkdir(path.join(upstream, "titles/psx"), { recursive: true });
    const platform = path.join(upstream, "titles/psx/fixture-title.json");
    const legacy = path.join(upstream, "titles/fixture-title.json");
    const run = () =>
      spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, checker], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, RETCOMM_CATALOG_DIR: upstream },
      });
    const valid = JSON.stringify({ release: { github: "owner/game" } });
    await writeFile(platform, valid);
    await writeFile(legacy, "{");
    assert.equal(
      run().status,
      0,
      "valid platform manifest must take precedence over malformed legacy",
    );
    await rm(platform);
    await writeFile(legacy, valid);
    assert.equal(run().status, 0, "missing platform manifest must use the legacy path");
    await writeFile(platform, "{");
    const malformed = run();
    assert.equal(malformed.status, 1);
    assert.doesNotMatch(malformed.stdout, /Checked \d+ direct PlayStation/u);
    assert.doesNotMatch(malformed.stderr, /NETWORK_FORBIDDEN/);
    await rm(platform);
    await mkdir(platform);
    const inaccessible = run();
    assert.equal(
      inaccessible.status,
      1,
      "non-ENOENT read errors must not fall back to valid legacy",
    );
    assert.doesNotMatch(inaccessible.stdout, /Checked \d+ direct PlayStation/u);
    assert.doesNotMatch(inaccessible.stderr, /NETWORK_FORBIDDEN/);
    await rm(platform, { recursive: true });
    await rm(legacy);
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no PSX title manifest for fixture-title/);
    assert.doesNotMatch(missing.stdout, /Checked \d+ direct PlayStation/u);
    assert.doesNotMatch(missing.stderr, /NETWORK_FORBIDDEN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
