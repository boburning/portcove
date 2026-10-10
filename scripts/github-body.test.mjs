import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
