import assert from "node:assert/strict";
import test from "node:test";
import { nextLink, parseIncludedResponse, rateLimitFromResponse } from "./github-api.mjs";

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
