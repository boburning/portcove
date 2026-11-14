import assert from "node:assert/strict";
import test from "node:test";
import {
  firstFunding,
  fundingCustomUrl,
  fundingUrlsFromYaml,
  githubRepository,
  graphqlFundingReader,
  resolveFunding,
  withFundingUrls,
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
    "community_bridge: ignored",
  ].join("\n");
  assert.deepEqual(fundingUrlsFromYaml(text), [
    "https://github.com/sponsors/first",
    "https://github.com/sponsors/second",
    "https://www.patreon.com/patron",
    "https://opencollective.com/collective",
    "https://ko-fi.com/maker",
    "https://liberapay.com/libre",
    "https://buymeacoffee.com/coffee",
    "https://example.com/donate",
  ]);
});

void test("malformed FUNDING.yml content yields no links", () => {
  for (const text of [
    "",
    "github:",
    "github: ['../escape', 'a b', '']",
    "custom: ['javascript:alert(1)', 'https://user:pw@example.com', 'https://example.com:8443/x']",
    "- just\n- a list",
    "github: [unclosed",
    "a: &x 1\nb: *x",
    `custom: '${"https://example.com/".padEnd(17_000, "a")}'`,
  ])
    assert.deepEqual(fundingUrlsFromYaml(text), [], text.slice(0, 80));
});

void test("links are deduplicated and bounded", () => {
  const custom = Array.from({ length: 20 }, (_, index) => `https://example.com/${index % 15}`);
  const urls = fundingUrlsFromYaml(`github: dup\ncustom: ${JSON.stringify(custom)}`);
  assert.equal(urls.length, 12);
  assert.equal(new Set(urls).size, 12);
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

void test("the first readable file decides and unknown answers stay unknown", () => {
  const funded = "ko_fi: maker";
  assert.deepEqual(firstFunding([null, funded, "github: other"], "missing"), [
    "https://ko-fi.com/maker",
  ]);
  assert.deepEqual(firstFunding([null, null, null], [funded, null, null]), [
    "https://ko-fi.com/maker",
  ]);
  assert.deepEqual(firstFunding([null, null, null], "missing"), []);
  assert.equal(firstFunding([null, undefined, funded], "missing"), undefined);
  assert.equal(firstFunding([null, null, null], null), undefined);
  assert.equal(firstFunding(null, "missing"), undefined);
  assert.equal(firstFunding("missing", [funded, null, null]), undefined);
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
  assert.deepEqual(Object.fromEntries(resolved), {
    own: ["https://github.com/sponsors/a"],
    fallback: ["https://liberapay.com/b"],
    nothing: [],
  });
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
