import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { errorCode, isRecord } from "./runtime-values.mts";
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
} from "./github-api.mts";

await test("only conditional REST GET accepts gh's nonzero valid304 response", () => {
  const output = "HTTP/2.0 304 Not Modified\r\netag: tag\r\n\r\n";
  const runner = createGitHubRunner({
    spawn: () => ({ status: 1, stdout: output, stderr: "gh: HTTP 304" }),
  });
  const args = [
    "api",
    "--include",
    "repos/example/repo/issues",
    "--method",
    "GET",
    "--header",
    "If-None-Match: tag",
  ];
  assert.equal(runner(args), output);
  assert.throws(() => runner(args.slice(0, -2)));
  assert.throws(() => runner(args.map((argument) => (argument === "GET" ? "PATCH" : argument))));
  const api = new GitHubApiClient(runner);
  assert.throws(
    () => api.request("GET", "example", null, { "If-None-Match": "tag\r\nInjected: true" }),
    /Invalid.*header/u,
  );
});

void test("included GitHub responses expose the final headers body and rate limit", () => {
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
  assert.deepEqual(response.body, { data: { viewer: { login: "example" } } });
  assert.deepEqual(rateLimitFromResponse(response), {
    resource: "graphql",
    limit: 5000,
    remaining: 4321,
    used: 679,
    resetAt: new Date(1789524000 * 1000).toISOString(),
  });
});

void test("JSON-only mock responses and paginated Link headers remain supported", () => {
  assert.deepEqual(parseIncludedResponse('{"ok":true}').body, { ok: true });
  const response = parseIncludedResponse(
    'HTTP/2.0 200 OK\nlink: <https://api.example/page/2>; rel="next", <https://api.example/page/9>; rel="last"\n\n[]',
  );
  assert.equal(nextLink(response.headers), "https://api.example/page/2");
});

void test("malformed included responses fail closed", () => {
  for (const value of ["not json", "HTTP/2.0 nope\r\n\r\n{}", "HTTP/2.0 200 OK\r\nbad\r\n\r\n{}"]) {
    assert.throws(() => parseIncludedResponse(value), /GitHub API|JSON|status|header/);
  }
});

void test("GraphQL sends shell-sensitive queries and variables only through JSON stdin", () => {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const client = new GitHubApiClient((args, input) => {
    calls.push({ args, input });
    return JSON.stringify({ data: { node: { id: "opaque" } } });
  });
  const query = 'query($value: String!) { node(id: "quote\\\" `$HOME\n雪") { id } }';
  const variables = { value: '"quoted"\n`literal` $HOME 雪' };
  assert.deepEqual(client.graphql(query, variables).data, { node: { id: "opaque" } });
  assert.deepEqual(calls, [
    {
      args: ["api", "graphql", "--include", "--input", "-"],
      input: `${JSON.stringify({ query, variables })}\n`,
    },
  ]);
});

void test("REST requests use JSON stdin and retain response metadata", () => {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
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

void test("REST pagination rejects loops duplicates changing totals and short reads", () => {
  const pages = new Map([
    [
      "first",
      'HTTP/2.0 200 OK\nlink: <second>; rel="next"\n\n{"total_count":2,"items":[{"id":"A"}]}',
    ],
    ["second", '{"total_count":2,"items":[{"id":"B"}]}'],
  ]);
  const client = new GitHubApiClient((args) => {
    const result = pages.get(args[2] ?? "");
    assert(result !== undefined);
    return result;
  });
  assert.deepEqual(
    client.paginateRest("first", {
      select: (body) => {
        assert(isRecord(body));
        return body.items;
      },
      identity: (item) => {
        assert(isRecord(item));
        return item.id;
      },
      totalCount: (body) => {
        assert(isRecord(body) && typeof body.total_count === "number");
        return body.total_count;
      },
      label: "items",
    }),
    [{ id: "A" }, { id: "B" }],
  );

  const firstPage = pages.get("first");
  assert(firstPage !== undefined);
  for (const [first, second, pattern] of [
    [
      firstPage,
      'HTTP/2.0 200 OK\nlink: <first>; rel="next"\n\n{"total_count":2,"items":[{"id":"B"}]}',
      /did not advance/,
    ],
    [firstPage, '{"total_count":2,"items":[{"id":"A"}]}', /duplicate ID/],
    [firstPage, '{"total_count":3,"items":[{"id":"B"}]}', /total changed/],
    [
      'HTTP/2.0 200 OK\nlink: <second>; rel="next"\n\n{"total_count":3,"items":[{"id":"A"}]}',
      '{"total_count":3,"items":[{"id":"B"}]}',
      /count does not match/,
    ],
  ] satisfies [string, string, RegExp][]) {
    const failing = new GitHubApiClient((args) => (args[2] === "first" ? first : second));
    assert.throws(
      () =>
        failing.paginateRest("first", {
          select: (body) => {
            assert(isRecord(body));
            return body.items;
          },
          identity: (item) => {
            assert(isRecord(item));
            return item.id;
          },
          totalCount: (body) => {
            assert(isRecord(body) && typeof body.total_count === "number");
            return body.total_count;
          },
          label: "items",
        }),
      pattern,
    );
  }
});

void test("GraphQL errors retain safe provider quota evidence", () => {
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
      error.code === "rate_limited" &&
      error.rateLimit?.remaining === 0 &&
      !error.message.includes("viewer"),
  );
});

void test("nonzero gh GraphQL responses preserve typed rate limits with quota still remaining", () => {
  for (const classification of [
    { type: "RATE_LIMITED" },
    { extensions: { code: "RATE_LIMITED" } },
  ]) {
    const body = JSON.stringify({
      errors: [{ ...classification, message: "API rate limit exceeded" }],
    });
    const client = new GitHubApiClient(
      createGitHubRunner({
        spawn: () => ({
          status: 1,
          stdout:
            "HTTP/2.0 200 OK\r\n" +
            "x-ratelimit-resource: graphql\r\n" +
            "x-ratelimit-limit: 5000\r\n" +
            "x-ratelimit-remaining: 58\r\n" +
            "x-ratelimit-used: 4942\r\n" +
            "x-ratelimit-reset: 1789524000\r\n" +
            "x-github-request-id: rate-request\r\n" +
            "date: Wed, 16 Sep 2026 02:00:00 GMT\r\n\r\n" +
            body,
          stderr: "gh: API rate limit exceeded for user ID 1.",
        }),
      }),
    );
    assert.throws(
      () => client.graphql("query { viewer { login } }"),
      (error) => {
        assert(error instanceof GitHubApiError);
        assert.equal(error.code, "rate_limited");
        assert.equal(error.status, 200);
        assert.equal(error.rateLimit?.remaining, 58);
        assert.equal(error.rateLimit?.resetAt, new Date(1789524000 * 1000).toISOString());
        assert.equal(error.requestId, "rate-request");
        assert.equal(error.responseDate, "Wed, 16 Sep 2026 02:00:00 GMT");
        assert.equal(error.responseBytes, Buffer.byteLength(body));
        assert.match(error.message, /58 points remain; reset at/u);
        return true;
      },
    );
    assert.equal(client.observations.length, 1);
    assert.equal(client.observations[0]?.failure, "rate_limited");
    assert.equal(client.observations[0]?.rate?.remaining, 58);
    assert.equal(client.observations[0]?.bytes, Buffer.byteLength(body));
  }
});

void test("nonzero GraphQL failures retain retry boundaries and reject partial mutation data", () => {
  const client = new GitHubApiClient(
    createGitHubRunner({
      spawn: () => ({
        status: 1,
        stdout:
          "HTTP/2.0 200 OK\r\nretry-after: 60\r\n\r\n" +
          JSON.stringify({
            data: { updateProject: { id: "partial" } },
            errors: [{ type: "RATE_LIMITED", message: "Temporarily limited" }],
          }),
        stderr: "gh: Temporarily limited",
      }),
    }),
  );
  assert.throws(
    () => client.graphql("mutation { updateProject { id } }"),
    (error) =>
      error instanceof GitHubApiError && error.code === "rate_limited" && error.retryAfter === "60",
  );
});

void test("nonzero GraphQL auth, schema and malformed failures are not mislabeled rate limits", () => {
  const cases = [
    [
      'HTTP/2.0 403 Forbidden\r\nx-ratelimit-remaining: 100\r\n\r\n{"message":"Forbidden"}',
      "command_failed",
      403,
    ],
    [
      'HTTP/2.0 200 OK\r\n\r\n{"errors":[{"type":"undefinedField","message":"Field unavailable"}]}',
      "graphql_error",
      200,
    ],
    ['HTTP/2.0 200 OK\r\n\r\n{"data":{"partial":true}}', "command_failed", 200],
    ["HTTP/2.0 200 OK\r\n\r\n{", "command_failed", null],
  ] as const;
  for (const [stdout, code, status] of cases) {
    const client = new GitHubApiClient(
      createGitHubRunner({
        spawn: () => ({ status: 1, stdout, stderr: "gh: rejected request" }),
      }),
    );
    assert.throws(
      () => client.graphql("query { viewer { login } }"),
      (error) => error instanceof GitHubApiError && error.code === code && error.status === status,
    );
    assert.equal(client.observations[0]?.failure, code);
  }
});

void test("the shared runner preserves command failures without echoing stdin", () => {
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

function outputFixture(
  stdout: string,
  stderr = "",
  options: Pick<
    NonNullable<Parameters<typeof createGitHubRunner>[0]>,
    "maxBuffer" | "timeoutMs"
  > = {},
) {
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

void test("the ordinary runner collects complete JSON above the former one MiB limit", () => {
  const body = { data: { value: "x".repeat(1100000) } };
  const client = new GitHubApiClient(outputFixture(JSON.stringify(body)));
  assert.deepEqual(client.graphql("query { value }").data, body.data);
});

void test("the runner passes a bounded default and preserves explicit finite overrides", () => {
  for (const limit of [undefined, 1024, 32 * 1024 * 1024]) {
    let options: SpawnSyncOptionsWithStringEncoding | undefined;
    const run = createGitHubRunner({
      ...(limit === undefined ? {} : { maxBuffer: limit }),
      spawn: (_command, _args, observed) => {
        options = observed;
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(run(["api", "graphql", "--include"], "private input"), "{}");
    assert(options);
    assert.equal(options.maxBuffer, limit ?? 16 * 1024 * 1024);
    assert.equal(options.input, "private input");
    assert.equal(options.encoding, "utf8");
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  }
});

void test("invalid output limits fail before any subprocess is started", () => {
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
          // @ts-expect-error -- Malformed boundary inputs must still be rejected before spawn.
          maxBuffer,
          spawn: () => {
            calls += 1;
            assert.fail("Invalid output limit reached subprocess execution");
          },
        }),
      /positive safe integer/,
    );
    assert.equal(calls, 0);
  }
});

void test("GitHub subprocesses have a finite default and validated explicit time bounds", () => {
  for (const timeoutMs of [undefined, 1000]) {
    const run = createGitHubRunner({
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      spawn: (_command, _args, options) => {
        assert.equal(options.timeout, timeoutMs ?? 15_000);
        assert.equal(options.killSignal, "SIGKILL");
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(run(["api", "graphql"]), "{}");
  }
  for (const timeoutMs of [null, 0, -1, 1.5, NaN, Infinity, "1000", 2_147_483_648]) {
    let calls = 0;
    assert.throws(
      () =>
        createGitHubRunner({
          // @ts-expect-error -- Malformed boundary inputs deliberately include non-number timeouts.
          timeoutMs,
          spawn: () => {
            calls++;
            assert.fail("Invalid timeout reached subprocess execution");
          },
        }),
      /timeout must be a positive integer/,
    );
    assert.equal(calls, 0);
  }
});

void test("an actually running stalled subprocess is terminated and its complete JSON discarded", () => {
  let observed: SpawnSyncReturns<string> | undefined;
  const client = new GitHubApiClient(
    createGitHubRunner({
      timeoutMs: 1000,
      spawn: (_command, _args, options) => {
        observed = spawnSync(
          process.execPath,
          [
            "-e",
            'process.on("SIGTERM", () => {}); process.stdout.write(\'{"data":{"accepted":true}}\'); process.stderr.write("private-stderr"); setInterval(() => {}, 1000);',
          ],
          options,
        );
        return observed;
      },
    }),
  );
  assert.throws(
    () => client.graphql("query { privateInput }"),
    (error) => {
      assert(error instanceof GitHubApiError);
      assert.equal(error.code, "command_failed");
      assert.equal(errorCode(error.cause), "ETIMEDOUT");
      assert.equal(error.status, null);
      assert.equal(error.rateLimit, null);
      assert.doesNotMatch(
        `${error.message} ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        /private|accepted/,
      );
      return true;
    },
  );
  assert(observed);
  assert.equal(observed.stdout, '{"data":{"accepted":true}}');
  assert.equal(observed.stderr, "private-stderr");
  assert.equal(errorCode(observed.error), "ETIMEDOUT");
});

void test("timeout diagnostics discard raw subprocess errors and do not retry mutations", () => {
  let calls = 0;
  const client = new GitHubApiClient(
    createGitHubRunner({
      spawn: () => {
        calls++;
        return {
          status: 0,
          error: Object.assign(new Error("authorization: github_pat_private"), {
            code: "ETIMEDOUT",
          }),
          stdout: '{"merged":true}',
          stderr: "private-stderr",
        };
      },
    }),
  );
  assert.throws(
    () => client.request("PUT", "repos/example/project/pulls/1/merge", { sha: "private-input" }),
    (error) => {
      assert(error instanceof GitHubApiError);
      assert.equal(errorCode(error.cause), "ETIMEDOUT");
      assert.doesNotMatch(
        `${error.message} ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        /private|authorization|merged/,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

void test("stdout and stderr overflow refuse even valid partial output without exposing payloads", () => {
  for (const [stdout, stderr] of [
    [JSON.stringify({ data: { value: "private-output".repeat(1000) } }), ""],
    ['{"data":', "private-stderr".repeat(1000)],
    [JSON.stringify({ data: { value: "complete but untrusted" } }), "private-stderr".repeat(1000)],
  ] satisfies [string, string][]) {
    const client = new GitHubApiClient(outputFixture(stdout, stderr, { maxBuffer: 1024 }));
    assert.throws(
      () => client.graphql("query { privateInput }"),
      (error) => {
        assert.ok(error instanceof GitHubApiError);
        assert.equal(error.code, "command_failed");
        assert.equal(errorCode(error.cause), "ENOBUFS");
        assert.match(error.message, /1024-byte collection limit/);
        assert.doesNotMatch(error.message, /private|untrusted|data/);
        assert.equal(error.status, null);
        assert.equal(error.rateLimit, null);
        return true;
      },
    );
  }
});

void test("overflow diagnostics discard the raw subprocess error as well as its output", () => {
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
      assert(error instanceof GitHubApiError);
      assert.equal(error.code, "command_failed");
      assert.equal(errorCode(error.cause), "ENOBUFS");
      assert.doesNotMatch(
        `${error.message} ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        /private|secret|authorization|token/,
      );
      assert.match(error.message, /1024-byte collection limit/);
      return true;
    },
  );
});

void test("truncated JSON below the cap remains a response failure rather than an overflow", () => {
  const client = new GitHubApiClient(outputFixture('{"data":', "", { maxBuffer: 1024 }));
  assert.throws(
    () => client.graphql("query { value }"),
    (error) => {
      assert(error instanceof GitHubApiError);
      assert.equal(error.code, "invalid_response");
      assert.doesNotMatch(error.message, /collection limit/);
      return true;
    },
  );
});

void test("operation envelopes share one stable schema and redact credential-shaped errors", () => {
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

void test("repository GitHub callers do not spawn gh outside the shared transport", async () => {
  for (const file of [
    "roadmap.mts",
    "pr-delivery.mts",
    "pr-conventions.mts",
    "repository-settings.mts",
    "source-provenance-audit.mts",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:spawn|spawnSync|execFile|execFileSync)\(\s*["']gh["']/u, file);
  }
});

void test("REST pagination refuses object-shaped IDs instead of treating equal values as distinct identities", () => {
  const client = new GitHubApiClient(() =>
    JSON.stringify([{ id: { value: "A" } }, { id: { value: "A" } }]),
  );
  assert.throws(
    () =>
      client.paginateRest("fixture", {
        identity: (record) => {
          assert(isRecord(record));
          return record.id;
        },
      }),
    /missing or duplicate ID/,
  );
});
