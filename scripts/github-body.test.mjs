import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkClosureIntent, readClosingRelationships } from "./closure-intent.mjs";

const repository = "boburning/portcove";
const emptyIntent = { format_version: 1, allowed_targets: [] };
function closingPage(nodes = [], extra = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          headRefOid: "a".repeat(40),
          title: "fix: safe",
          body: "Related to #244.",
          closingIssuesReferences: {
            totalCount: nodes.length,
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
            ...extra,
          },
        },
      },
    },
  };
}

test("closure permission is independent, canonical and covers variants and hidden text", () => {
  for (const keyword of [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ]) {
    for (const target of ["#244", "Boburning/Portcove#244"]) {
      const text = `${keyword.toUpperCase()}: ${target}`;
      assert.throws(
        () => checkClosureIntent(emptyIntent, { repository, texts: [text] }),
        /Undeclared/,
      );
      assert.deepEqual(
        checkClosureIntent(
          { format_version: 1, allowed_targets: ["boburning/portcove#244"] },
          { repository, texts: [text] },
        ),
        ["boburning/portcove#244"],
      );
    }
  }
  assert.throws(() => checkClosureIntent(undefined, { repository }), /independent/);
  assert.throws(
    () => checkClosureIntent(emptyIntent, { repository, texts: ["<!-- Closes #244 -->"] }),
    /Undeclared/,
  );
  assert.throws(
    () =>
      checkClosureIntent(
        { format_version: 1, allowed_targets: ["boburning/portcove#244"] },
        { repository, texts: ["does not close #244"] },
      ),
    /negated/,
  );
  assert.deepEqual(
    checkClosureIntent(emptyIntent, { repository, texts: ["Related to #244."] }),
    [],
  );
  assert.throws(
    () => checkClosureIntent(emptyIntent, { repository, relationships: ["other/repo#244"] }),
    /Undeclared/,
  );
});

test("closing relationships require complete stable opaque identities and cursors", () => {
  const issue = { id: "opaque-issue", number: 244, repository: { nameWithOwner: repository } };
  assert.deepEqual(
    readClosingRelationships({ graphql: () => closingPage([issue]) }, repository, 7).relationships,
    ["boburning/portcove#244"],
  );
  for (const extra of [
    { totalCount: 2 },
    { pageInfo: {} },
    { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: null } },
  ])
    assert.throws(
      () => readClosingRelationships({ graphql: () => closingPage([issue], extra) }, repository, 7),
      /incomplete/,
    );
  assert.throws(
    () => readClosingRelationships({ graphql: () => closingPage([issue, issue]) }, repository, 7),
    /Duplicate/,
  );
  let page = 0;
  const api = {
    graphql() {
      const value = closingPage([{ ...issue, id: `id-${page}`, number: 244 + page }], {
        totalCount: 2,
        pageInfo: { hasNextPage: page === 0, endCursor: "cursor" },
      });
      if (page++) value.data.repository.pullRequest.body = "Changed without head change";
      return value;
    },
  };
  assert.throws(() => readClosingRelationships(api, repository, 7), /changed/);
});

test("PR writer refuses undeclared intent before mutation", () => {
  const api = {
    request() {
      assert.fail("No remote mutation permitted");
    },
  };
  assert.throws(
    () =>
      writeGitHubBody(
        {
          operation: "pr-create",
          body: "Closes #244",
          title: "fix: scoped",
          head: "feature/scoped",
          base: "main",
          closureIntent: emptyIntent,
        },
        api,
      ),
    /Undeclared/,
  );
  assert.throws(
    () =>
      parseBodyArguments([
        "pr-create",
        "--body-file",
        "body",
        "--title",
        "title",
        "--head",
        "branch",
        "--base",
        "main",
      ]),
    /Missing/,
  );
});

test("PR body edit checks fresh manual links before any write", () => {
  let writes = 0;
  const page = closingPage([
    { id: "manual", number: 244, repository: { nameWithOwner: repository } },
  ]);
  const api = {
    graphql: () => page,
    request(method) {
      if (method !== "GET") writes++;
      return {
        body: { id: 123, number: 7, body: "Related to #244.", head: { sha: "a".repeat(40) } },
      };
    },
  };
  assert.throws(
    () =>
      writeGitHubBody(
        {
          operation: "pr-edit",
          target: 7,
          previousBody: "Related to #244.",
          body: "Related to #202.",
          closureIntent: emptyIntent,
        },
        api,
      ),
    /Undeclared/,
  );
  assert.equal(writes, 0);
});

test("relationship pagination completes multiple pages and refuses repeated cursors", () => {
  let page = 0;
  const api = {
    graphql() {
      const index = page++;
      return closingPage(
        [{ id: `id-${index}`, number: 244 + index, repository: { nameWithOwner: repository } }],
        { totalCount: 2, pageInfo: { hasNextPage: index === 0, endCursor: "first" } },
      );
    },
  };
  assert.equal(readClosingRelationships(api, repository, 7).relationships.length, 2);
  page = 0;
  api.graphql = () =>
    closingPage(
      [{ id: `id-${page}`, number: 244 + page++, repository: { nameWithOwner: repository } }],
      { totalCount: 4, pageInfo: { hasNextPage: true, endCursor: "same" } },
    );
  assert.throws(() => readClosingRelationships(api, repository, 7), /pagination is incomplete/);
});
import {
  validateGitHubBody,
  readGitHubBody,
  writeGitHubBody,
  parseBodyArguments,
} from "./github-body.mjs";

test("text guard preserves Markdown, Unicode and CRLF but rejects malformed text", (t) => {
  const body = "## Résumé 🎮\r\n\t`roadmap` and $(literal)\n";
  assert.equal(validateGitHubBody(body), body);
  for (const bad of [
    "bad\rbody",
    "bad\u0000body",
    "bad\u001bbody",
    "bad\u007fbody",
    "bad\ud800",
    " ",
  ])
    assert.throws(() => validateGitHubBody(bad));
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-body-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "body.md");
  writeFileSync(file, `\uFEFF${body}`);
  assert.equal(readGitHubBody(file), body);
  writeFileSync(file, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readGitHubBody(file));
});

test("text guard preserves every C0 and DEL boundary and the first UTF-16 offset", () => {
  const prefix = "Résumé 🎮\r\n";
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const body = `${prefix}${String.fromCharCode(code)}tail`;
    if (code === 9 || code === 10) {
      assert.equal(validateGitHubBody(body), body);
    } else {
      assert.throws(() => validateGitHubBody(body), {
        message: `Unexpected control character at text offset ${prefix.length}`,
      });
    }
  }
  assert.equal(validateGitHubBody("before\r\nafter"), "before\r\nafter");
  assert.throws(() => validateGitHubBody("before\r"), {
    message: "Unexpected control character at text offset 6",
  });
  assert.throws(() => validateGitHubBody(`${prefix}${String.fromCharCode(0, 27)}`), {
    message: `Unexpected control character at text offset ${prefix.length}`,
  });
});

test("edits compare fresh preimages and verify exact validated content", () => {
  const calls = [];
  const body = "new `body`\r\n🎮";
  const api = {
    request(method, endpoint, payload) {
      calls.push({ method, endpoint, payload });
      return {
        body: {
          id: 123,
          number: 1685,
          html_url: "https://github.com/boburning/portcove/issues/1685",
          body: calls.length === 1 ? "old" : body,
        },
      };
    },
  };
  assert.equal(
    writeGitHubBody({ operation: "issue-edit", target: 1685, previousBody: "old", body }, api)
      .verified,
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PATCH", "GET"],
  );
  assert.equal(calls[1].payload.body, body);
  calls.length = 0;
  assert.throws(
    () =>
      writeGitHubBody(
        { operation: "issue-edit", target: 1685, previousBody: "changed", body },
        api,
      ),
    /Remote body changed/,
  );
  assert.equal(calls.length, 1);
});

test("mutations retain response observations, never retry and refuse bad readback", () => {
  let writes = 0;
  const observations = [];
  const api = {
    request(method) {
      if (method === "POST") {
        writes++;
        return { body: { id: 55 } };
      }
      return { body: { id: 55, number: 1685, body: "different" } };
    },
  };
  assert.throws(
    () =>
      writeGitHubBody(
        {
          operation: "pr-comment",
          target: 1685,
          body: "candidate",
          observe: (entry) => observations.push(entry),
        },
        api,
      ),
    /readback mismatch/,
  );
  assert.equal(writes, 1);
  assert.ok(observations.some((entry) => entry.phase === "mutation" && entry.result.id === 55));
  const timeout = new Error("ambiguous timeout");
  const failing = {
    request(method) {
      if (method === "POST") {
        writes++;
        throw timeout;
      }
      return { body: { id: 1, number: 1685 } };
    },
  };
  assert.throws(
    () => writeGitHubBody({ operation: "issue-comment", target: 1685, body: "candidate" }, failing),
    (error) => error === timeout,
  );
  assert.equal(writes, 2);
});

test("body writer restricts operations and repository identity before mutations", () => {
  const api = {
    request() {
      assert.fail("Unexpected API call");
    },
  };
  assert.throws(() =>
    writeGitHubBody(
      {
        operation: "issue-edit",
        target: "https://github.com/other/repo/issues/1",
        body: "candidate",
        previousBody: "old",
      },
      api,
    ),
  );
  assert.throws(() =>
    parseBodyArguments(["issue-edit", "--target", "1", "--body-file", "candidate"]),
  );
  assert.throws(() =>
    parseBodyArguments([
      "issue-comment",
      "--target",
      "1",
      "--body-file",
      "candidate",
      "--body-file",
      "duplicate",
    ]),
  );
  assert.throws(() => parseBodyArguments(["issue-create", "--body-file", "candidate"]));
});
