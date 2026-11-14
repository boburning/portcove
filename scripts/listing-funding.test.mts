import assert from "node:assert/strict";
import test from "node:test";
import {
  firstFunding,
  fundingCustomUrl,
  githubRepository,
  graphqlFundingReader,
  missingRepositoryReason,
  parseFundingYaml,
  plannedFunding,
  resolveFunding,
  withFundingUrls,
  type FundingResolution,
} from "./listing-funding.mts";

void test("known FUNDING.yml platforms become fixed-order HTTPS links", () => {
  const text = [
    "custom: ['https://example.com/donate', 'http://insecure.example', 'paypal.me/someone']",
    "ko_fi: maker",
    "github: [first, second]",
    "patreon: patron",
    "open_collective: collective",
    "liberapay: libre",
    "buy_me_a_coffee: coffee",
    "tidelift: npm/package",
    "community_bridge: ''",
  ].join("\n");
  assert.deepEqual(parseFundingYaml(text), {
    urls: [
      "https://github.com/sponsors/first",
      "https://github.com/sponsors/second",
      "https://www.patreon.com/patron",
      "https://opencollective.com/collective",
      "https://ko-fi.com/maker",
      "https://liberapay.com/libre",
      "https://buymeacoffee.com/coffee",
      "https://example.com/donate",
    ],
    // Unsupported platforms and unusable values are reported, not silently ignored.
    skipped: ["tidelift", 'custom: "http://insecure.example"', 'custom: "paypal.me/someone"'],
    dropped: [],
  });
});

void test("files that cannot be read as usable links are unknown, not empty", () => {
  for (const [text, reason] of [
    ["", "no-supported-links"],
    ["github:", "no-supported-links"],
    ["tidelift: npm/package", "no-supported-links"],
    ["github: ['../escape', 'a b', '']", "no-supported-links"],
    [
      "custom: ['javascript:alert(1)', 'https://user:pw@example.com', 'https://example.com:8443/x']",
      "no-supported-links",
    ],
    ["- just\n- a list", "malformed"],
    ["github: [unclosed", "malformed"],
    ["anchor: &x first\ngithub: *x", "malformed"],
    [`custom: '${"https://example.com/".padEnd(17_000, "a")}'`, "oversized"],
  ] as const) {
    const parsed = parseFundingYaml(text);
    assert.ok("unknown" in parsed && parsed.unknown === reason, `${text.slice(0, 60)}: ${reason}`);
  }
});

void test("links over the Core bound keep the first in order and report the rest", () => {
  const custom = Array.from({ length: 20 }, (_, index) => `https://example.com/${index % 15}`);
  const parsed = parseFundingYaml(`github: dup\ncustom: ${JSON.stringify(custom)}`);
  assert.ok("urls" in parsed);
  assert.equal(parsed.urls.length, 12);
  assert.equal(parsed.urls[0], "https://github.com/sponsors/dup");
  assert.deepEqual(parsed.dropped, [
    "https://example.com/11",
    "https://example.com/12",
    "https://example.com/13",
    "https://example.com/14",
  ]);
  assert.equal(fundingCustomUrl(' "https://example.com/a"'), undefined);
  assert.equal(fundingCustomUrl("https://example.com"), "https://example.com/");
});

void test("only github.com project URLs are looked up", () => {
  assert.deepEqual(githubRepository("https://github.com/owner/game.git"), {
    owner: "owner",
    name: "game",
  });
  for (const url of [
    "https://gitlab.com/owner/game",
    "https://github.com/owner",
    "https://github.com/owner/game/tree/main",
    "http://github.com/owner/game",
  ])
    assert.equal(githubRepository(url), undefined, url);
});

void test("only a readable project with no file anywhere means no links", () => {
  const repository = { owner: "owner", name: "game" };
  const funded = "ko_fi: maker";
  assert.deepEqual(firstFunding(repository, [null, funded, "github: other"], "missing"), {
    kind: "links",
    source: "owner/game:FUNDING.yml",
    urls: ["https://ko-fi.com/maker"],
    skipped: [],
    dropped: [],
  });
  assert.deepEqual(firstFunding(repository, [null, null, null], [funded, null, null]), {
    kind: "links",
    source: "owner/.github:.github/FUNDING.yml",
    urls: ["https://ko-fi.com/maker"],
    skipped: [],
    dropped: [],
  });
  assert.deepEqual(firstFunding(repository, [null, null, null], "missing"), { kind: "none" });
  assert.deepEqual(firstFunding(repository, [null, null, null], [null, null, null]), {
    kind: "none",
  });
  for (const [own, owner, reason] of [
    [[null, undefined, funded], "missing", "unreadable"],
    [[null, null, null], null, "unreadable"],
    [null, "missing", "unreadable"],
    ["missing", [funded, null, null], "project-missing"],
    [["github: [broken", null, null], "missing", "malformed"],
    [["tidelift: npm/x", null, null], "missing", "no-supported-links"],
  ] as const)
    assert.equal(
      (firstFunding(repository, own as never, owner as never) as { reason?: string }).reason,
      reason,
    );
  // The first file found decides, even when it has nothing usable: no fallback past it.
  assert.equal(
    firstFunding(repository, ["tidelift: npm/x", null, null], [funded, null, null]).kind,
    "unknown",
  );
});

void test("the GraphQL reader separates absence, unreadable files and incomplete answers", async () => {
  const queries: string[] = [];
  const read = graphqlFundingReader(async (query) => {
    queries.push(query);
    return {
      data: {
        r0: { f0: null, f1: { text: "ko_fi: maker", isBinary: false, byteSize: 12 }, f2: null },
        r1: null,
        r3: { f0: { text: "x", isBinary: true, byteSize: 1 }, f1: null, f2: null },
      },
    };
  });
  const result = await read([
    { owner: "Owner", name: "Funded" },
    { owner: "gone", name: "repo" },
    { owner: "hidden", name: "repo" },
    { owner: "binary", name: "repo" },
  ]);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /r0: resource\(url: "https:\/\/github\.com\/Owner\/Funded"\)/u);
  assert.deepEqual(result.get("owner/funded"), [null, "ko_fi: maker", null]);
  assert.equal(result.get("gone/repo"), "missing");
  assert.equal(result.get("hidden/repo"), null);
  assert.deepEqual(result.get("binary/repo"), [undefined, null, null]);
});

void test("projects without their own file fall back to the owner's .github repository", async () => {
  const requested: string[][] = [];
  const answers = new Map<string, (string | null)[] | "missing" | null>([
    ["a/own", [null, "github: a", null]],
    ["b/none", [null, null, null]],
    ["b/.github", ["liberapay: b", null, null]],
    ["c/none", [null, null, null]],
    ["c/.github", "missing"],
    ["d/unknown", null],
  ]);
  const resolved = await resolveFunding(
    [
      { id: "own", project_url: "https://github.com/a/own" },
      { id: "fallback", project_url: "https://github.com/b/none" },
      { id: "nothing", project_url: "https://github.com/c/none" },
      { id: "unknown", project_url: "https://github.com/d/unknown" },
      { id: "elsewhere", project_url: "https://gitlab.com/e/game" },
    ],
    async (repositories) => {
      requested.push(repositories.map(({ owner, name }) => `${owner}/${name}`));
      return new Map(
        repositories.map(({ owner, name }) => [
          `${owner}/${name}`.toLowerCase(),
          answers.get(`${owner}/${name}`) ?? null,
        ]),
      );
    },
  );
  assert.deepEqual(requested, [
    ["a/own", "b/none", "c/none", "d/unknown"],
    ["b/.github", "c/.github"],
  ]);
  assert.deepEqual(
    Object.fromEntries(
      [...resolved].map(([id, value]) => [id, "urls" in value ? value.urls : value.kind]),
    ),
    {
      own: ["https://github.com/sponsors/a"],
      fallback: ["https://liberapay.com/b"],
      nothing: "none",
      unknown: "unknown",
    },
  );
});

void test("existing links are replaced or removed only with --replace", () => {
  const links = (urls: string[]): FundingResolution => ({
    kind: "links",
    urls,
    source: "o/r:FUNDING.yml",
    skipped: [],
    dropped: [],
  });
  const authored = ["https://example.org/hand-authored"];
  assert.deepEqual(plannedFunding(undefined, links(["https://ko-fi.com/a"]), false), {
    urls: ["https://ko-fi.com/a"],
  });
  assert.deepEqual(plannedFunding(authored, links(["https://ko-fi.com/a"]), false), {
    held: "replace",
  });
  assert.deepEqual(plannedFunding(authored, { kind: "none" }, false), { held: "remove" });
  assert.deepEqual(plannedFunding(authored, { kind: "none" }, true), { urls: [] });
  assert.deepEqual(plannedFunding(authored, links(["https://ko-fi.com/a"]), true), {
    urls: ["https://ko-fi.com/a"],
  });
  assert.deepEqual(plannedFunding(authored, links(authored), false), {});
  assert.deepEqual(plannedFunding(undefined, { kind: "none" }, true), {});
  for (const replace of [false, true])
    assert.deepEqual(
      plannedFunding(authored, { kind: "unknown", reason: "malformed" }, replace),
      {},
    );
});

void test("a repository GraphQL cannot resolve is reported as moved or gone", async () => {
  const responses = new Map<string, { status: number | null; data: unknown }>([
    ["/repos/old/name", { status: 301, data: { url: "https://api.github.com/repositories/42" } }],
    ["/repositories/42", { status: 200, data: { full_name: "new-owner/new-name" } }],
    ["/repos/gone/name", { status: 404, data: undefined }],
    ["/repos/odd/name", { status: 500, data: undefined }],
  ]);
  const get = async (path: string) => responses.get(path) ?? { status: null, data: undefined };
  assert.equal(
    await missingRepositoryReason({ owner: "old", name: "name" }, get),
    "moved to new-owner/new-name; update project_url",
  );
  assert.equal(await missingRepositoryReason({ owner: "gone", name: "name" }, get), "not found");
  assert.equal(
    await missingRepositoryReason({ owner: "odd", name: "name" }, get),
    "not resolvable",
  );
});

void test("the port file edit touches only funding_urls", () => {
  const text = [
    "{",
    '  "format_version": 1,',
    '  "listing": {',
    '    "id": "fixture",',
    '    "project_url": "https://github.com/owner/game",',
    '    "listed_at": "2026-11-09",',
    '    "availability": "unknown"',
    "  }",
    "}",
    "",
  ].join("\n");
  const added = withFundingUrls(text, ["https://ko-fi.com/maker"]);
  assert.match(
    added,
    /"listed_at": "2026-11-09",\n {4}"funding_urls": \["https:\/\/ko-fi\.com\/maker"\],\n/u,
  );
  // A wrapped array from the formatter is recognised as equal and replaced as a whole.
  const wrapped = added.replace(
    '["https://ko-fi.com/maker"]',
    '[\n      "https://ko-fi.com/maker"\n    ]',
  );
  assert.equal(withFundingUrls(wrapped, ["https://ko-fi.com/maker"]), wrapped);
  const replaced = withFundingUrls(wrapped, ["https://liberapay.com/x", "https://ko-fi.com/y"]);
  const parsed = JSON.parse(replaced) as { listing: { funding_urls?: unknown } };
  assert.deepEqual(parsed.listing.funding_urls, ["https://liberapay.com/x", "https://ko-fi.com/y"]);
  assert.equal(withFundingUrls(replaced, []), text);
  assert.equal(withFundingUrls(text, []), text);
});
