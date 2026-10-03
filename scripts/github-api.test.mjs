import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GitHubApiClient,
  GitHubApiError,
  createGitHubRunner,
  githubOperationEnvelope,
  nextLink,
  parseIncludedResponse,
  rateLimitFromResponse,
  sanitizeOperationError,
} from "./github-api.mjs";

test("included GitHub responses expose the final headers body and rate limit", () => {
  const response = parseIncludedResponse(
    "HTTP/2.0 200 OK\r\n" +
      "x-ratelimit-resource: graphql\r\n" +
      "x-ratelimit-limit: 5000\r\n" +
      "x-ratelimit-remaining: 4321\r\n" +
      "x-ratelimit-used: 679\r\n" +
      "x-ratelimit-reset: 1789524000\r\n\r\n" +
      '{"data":{"viewer":{"login":"example"}}}',
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.data.viewer.login, "example");
  assert.deepEqual(rateLimitFromResponse(response), {
    resource: "graphql",
    limit: 5000,
    remaining: 4321,
    used: 679,
    resetAt: new Date(1789524000 * 1000).toISOString(),
  });
});

test("JSON-only mock responses and paginated Link headers remain supported", () => {
  assert.deepEqual(parseIncludedResponse('{"ok":true}').body, { ok: true });
  const response = parseIncludedResponse(
    'HTTP/2.0 200 OK\nlink: <https://api.example/page/2>; rel="next", <https://api.example/page/9>; rel="last"\n\n[]',
  );
  assert.equal(nextLink(response.headers), "https://api.example/page/2");
});

test("malformed included responses fail closed", () => {
  for (const value of ["not json", "HTTP/2.0 nope\r\n\r\n{}", "HTTP/2.0 200 OK\r\nbad\r\n\r\n{}"]) {
    assert.throws(() => parseIncludedResponse(value), /GitHub API|JSON|status|header/);
  }
});

test("GraphQL sends shell-sensitive queries and variables only through JSON stdin", () => {
  const calls = [];
  const client = new GitHubApiClient((args, input) => {
    calls.push({ args, input });
    return JSON.stringify({ data: { node: { id: "opaque" } } });
  });
  const query = 'query($value: String!) { node(id: "quote\\\" `$HOME\n雪") { id } }';
  const variables = { value: '"quoted"\n`literal` $HOME 雪' };
  assert.equal(client.graphql(query, variables).data.node.id, "opaque");
  assert.deepEqual(calls, [
    {
      args: ["api", "graphql", "--include", "--input", "-"],
      input: `${JSON.stringify({ query, variables })}\n`,
    },
  ]);
});

test("REST requests use JSON stdin and retain response metadata", () => {
  const calls = [];
  const client = new GitHubApiClient((args, input) => {
    calls.push({ args, input });
    return 'HTTP/2.0 200 OK\r\nx-ratelimit-resource: core\r\nx-ratelimit-remaining: 4999\r\n\r\n{"ok":true}';
  });
  const response = client.request("PATCH", "repos/example/project", { value: '"safe"' });
  assert.deepEqual(response.body, { ok: true });
  assert.equal(response.rateLimit.remaining, 4999);
  assert.deepEqual(calls, [
    {
      args: ["api", "--include", "repos/example/project", "--method", "PATCH", "--input", "-"],
      input: '{"value":"\\\"safe\\\""}\n',
    },
  ]);
});

test("REST pagination rejects loops duplicates changing totals and short reads", () => {
  const pages = new Map([
    [
      "first",
      'HTTP/2.0 200 OK\nlink: <second>; rel="next"\n\n{"total_count":2,"items":[{"id":"A"}]}',
    ],
    ["second", '{"total_count":2,"items":[{"id":"B"}]}'],
  ]);
  const client = new GitHubApiClient((args) => pages.get(args[2]));
  assert.deepEqual(
    client.paginateRest("first", {
      select: (body) => body.items,
      identity: (item) => item.id,
      totalCount: (body) => body.total_count,
      label: "items",
    }),
    [{ id: "A" }, { id: "B" }],
  );

  for (const [first, second, pattern] of [
    [
      pages.get("first"),
      'HTTP/2.0 200 OK\nlink: <first>; rel="next"\n\n{"total_count":2,"items":[{"id":"B"}]}',
      /did not advance/,
    ],
    [pages.get("first"), '{"total_count":2,"items":[{"id":"A"}]}', /duplicate ID/],
    [pages.get("first"), '{"total_count":3,"items":[{"id":"B"}]}', /total changed/],
    [
      'HTTP/2.0 200 OK\nlink: <second>; rel="next"\n\n{"total_count":3,"items":[{"id":"A"}]}',
      '{"total_count":3,"items":[{"id":"B"}]}',
      /count does not match/,
    ],
  ]) {
    const failing = new GitHubApiClient((args) => (args[2] === "first" ? first : second));
    assert.throws(
      () =>
        failing.paginateRest("first", {
          select: (body) => body.items,
          identity: (item) => item.id,
          totalCount: (body) => body.total_count,
          label: "items",
        }),
      pattern,
    );
  }
});

test("GraphQL errors retain safe provider quota evidence", () => {
  const client = new GitHubApiClient(() =>
    JSON.stringify({
      data: { rateLimit: { cost: 1, limit: 5000, remaining: 0, resetAt: "soon", used: 5000 } },
      errors: [{ message: "quota exhausted" }],
    }),
  );
  assert.throws(
    () => client.graphql("query { viewer { login } }"),
    (error) =>
      error instanceof GitHubApiError &&
      error.code === "graphql_error" &&
      error.rateLimit.remaining === 0 &&
      !error.message.includes("viewer"),
  );
});

test("the shared runner preserves command failures without echoing stdin", () => {
  const run = createGitHubRunner({
    spawn: (_command, _args, options) => ({
      error: null,
      status: 1,
      stdout: "",
      stderr: options.input ? "request rejected" : "command rejected",
    }),
  });
  assert.throws(
    () => run(["api", "graphql", "--input", "-"], "secret query"),
    (error) =>
      error instanceof GitHubApiError &&
      error.code === "command_failed" &&
      error.message === "request rejected" &&
      !error.message.includes("secret query"),
  );
});

function outputFixture(stdout, stderr = "", options = {}) {
  return createGitHubRunner({
    ...options,
    spawn: (_command, _args, spawnOptions) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          "const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); process.stdout.write(input.stdout); process.stderr.write(input.stderr);",
        ],
        { ...spawnOptions, input: JSON.stringify({ stdout, stderr }) },
      ),
  });
}

test("the ordinary runner collects complete JSON above the former one MiB limit", () => {
  const body = { data: { value: "x".repeat(1100000) } };
  const client = new GitHubApiClient(outputFixture(JSON.stringify(body)));
  assert.deepEqual(client.graphql("query { value }").data, body.data);
});

test("the runner passes a bounded default and preserves explicit finite overrides", () => {
  for (const limit of [undefined, 1024, 32 * 1024 * 1024]) {
    let options;
    const run = createGitHubRunner({
      ...(limit === undefined ? {} : { maxBuffer: limit }),
      spawn: (_command, _args, observed) => {
        options = observed;
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(run(["api", "graphql", "--include"], "private input"), "{}");
    assert.equal(options.maxBuffer, limit ?? 16 * 1024 * 1024);
    assert.equal(options.input, "private input");
    assert.equal(options.encoding, "utf8");
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  }
});

test("invalid output limits fail before any subprocess is started", () => {
  for (const maxBuffer of [
    null,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    "1024",
    true,
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        createGitHubRunner({
          maxBuffer,
          spawn: () => {
            calls += 1;
          },
        }),
      /positive safe integer/,
    );
    assert.equal(calls, 0);
  }
});

test("stdout and stderr overflow refuse even valid partial output without exposing payloads", () => {
  for (const [stdout, stderr] of [
    [JSON.stringify({ data: { value: "private-output".repeat(1000) } }), ""],
    ['{"data":', "private-stderr".repeat(1000)],
    [JSON.stringify({ data: { value: "complete but untrusted" } }), "private-stderr".repeat(1000)],
  ]) {
    const client = new GitHubApiClient(outputFixture(stdout, stderr, { maxBuffer: 1024 }));
    assert.throws(
      () => client.graphql("query { privateInput }"),
      (error) => {
        assert.ok(error instanceof GitHubApiError);
        assert.equal(error.code, "command_failed");
        assert.equal(error.cause.code, "ENOBUFS");
        assert.match(error.message, /1024-byte collection limit/);
        assert.doesNotMatch(error.message, /private|untrusted|data/);
        assert.equal(error.status, null);
        assert.equal(error.rateLimit, null);
        return true;
      },
    );
  }
});

test("overflow diagnostics discard the raw subprocess error as well as its output", () => {
  const run = createGitHubRunner({
    maxBuffer: 1024,
    spawn: () => ({
      status: 0,
      error: Object.assign(new Error("authorization: github_pat_private"), { code: "ENOBUFS" }),
      stdout: '{"data":{"accepted":true}}',
      stderr: "token=ghp_private",
    }),
  });
  assert.throws(
    () => run(["api", "graphql", "--include"], "secret input"),
    (error) => {
      assert.equal(error.code, "command_failed");
      assert.equal(error.cause.code, "ENOBUFS");
      assert.doesNotMatch(
        `${error.message} ${error.cause.message}`,
        /private|secret|authorization|token/,
      );
      assert.match(error.message, /1024-byte collection limit/);
      return true;
    },
  );
});

test("truncated JSON below the cap remains a response failure rather than an overflow", () => {
  const client = new GitHubApiClient(outputFixture('{"data":', "", { maxBuffer: 1024 }));
  assert.throws(
    () => client.graphql("query { value }"),
    (error) => {
      assert.equal(error.code, "invalid_response");
      assert.doesNotMatch(error.message, /collection limit/);
      return true;
    },
  );
});

test("operation envelopes share one stable schema and redact credential-shaped errors", () => {
  assert.deepEqual(
    githubOperationEnvelope({
      operation: "roadmap.set-many",
      status: "partial",
      summary: "one chunk remains",
      evidence: { completed: 25, remaining: 1 },
      error: Object.assign(new Error("authorization: github_pat_secret"), { code: "quota" }),
    }),
    {
      schema_version: 1,
      operation: "roadmap.set-many",
      status: "partial",
      summary: "one chunk remains",
      evidence: { completed: 25, remaining: 1 },
      error: { code: "quota", message: "authorization=[REDACTED]" },
    },
  );
  assert.deepEqual(sanitizeOperationError(new Error("token=ghp_secret")), {
    code: "operation_failed",
    message: "token=[REDACTED]",
  });
  assert.throws(
    () => githubOperationEnvelope({ operation: "x", status: "waiting", summary: "x" }),
    /unsupported operation status/,
  );
});

test("repository GitHub callers do not spawn gh outside the shared transport", async () => {
  for (const file of [
    "roadmap.mjs",
    "pr-delivery.mjs",
    "pr-conventions.mjs",
    "repository-settings.mjs",
    "source-provenance-audit.mjs",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:spawn|spawnSync|execFile|execFileSync)\(\s*["']gh["']/u, file);
  }
});
