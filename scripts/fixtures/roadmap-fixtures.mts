import { isRecord } from "../runtime-values.mts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateConfig } from "../roadmap.mts";

export interface RunnerCall {
  args: readonly string[];
  input?: string | undefined;
}

export function fixtureValue<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "expected present fixture value");
  return value;
}

export function fixtureFind<T>(values: readonly T[], predicate: (value: T) => boolean): T {
  return fixtureValue(values.find(predicate));
}

export function fixtureElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, `expected fixture element ${index}`);
  return value;
}

export function fixtureObject(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected a structured fixture boundary value");
  return value;
}

export function fixtureJsonObject(input: unknown) {
  assert.ok(typeof input === "string", "expected serialized fixture input");
  const value: unknown = JSON.parse(input);
  return fixtureObject(value);
}

export function fixtureGraphql(input: unknown) {
  const value = fixtureJsonObject(input);
  assert.ok(typeof value.query === "string" && isRecord(value.variables));
  return { query: value.query, variables: value.variables };
}

export const config = validateConfig(
  JSON.parse(await readFile(new URL("../../.github/roadmap.json", import.meta.url), "utf8")),
);

export function fixtureProjectDetails(
  args: readonly string[],
  input: string | undefined,
  id: string,
  number = config.project.number,
) {
  if (args[0] === "api" && args[2] === "users/boburning") return JSON.stringify({ type: "User" });
  if (args[0] !== "api" || args[1] !== "graphql") return undefined;
  const request = fixtureGraphql(input);
  if (
    !request.query.includes("user(login: $login)") ||
    !request.query.includes("projectV2(number: $number)") ||
    request.query.includes("fields(")
  )
    return undefined;
  assert.equal(request.variables.login, "boburning");
  assert.equal(request.variables.number, number);
  return JSON.stringify({ data: { user: { projectV2: { id, number } } } });
}

/** Actual configured SDK against a controlled fetch boundary. These handlers
 * return provider data, never CLI arguments or included-HTTP strings. */
export async function sdkRoadmap(
  selectedConfig: typeof config,
  handlers: {
    graphql?: (query: string, variables: Readonly<Record<string, unknown>>) => unknown;
    rest?: (request: { method: string; endpoint: string; body: unknown }) => unknown;
    allowMutations?: boolean;
    maxBytes?: number;
  },
) {
  const { RoadmapClient } = await import("../roadmap.mts");
  return RoadmapClient.connect(selectedConfig, {
    credential: { kind: "anonymous" },
    ...(handlers.maxBytes === undefined ? {} : { maxBytes: handlers.maxBytes }),
    deadline: performance.now() + 10000,
    failedReads: new Map(),
    deferral: { primary: new Map(), secondary: 0 },
    allowMutations: handlers.allowMutations ?? false,
    random: () => 0,
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      let data: unknown;
      if (url.pathname === "/graphql") {
        assert.ok(isRecord(body) && typeof body.query === "string" && isRecord(body.variables));
        assert.ok(handlers.graphql, "Unexpected GraphQL request");
        data = await handlers.graphql(body.query, body.variables);
        if (!(data instanceof Response)) data = { data };
      } else if (handlers.rest) {
        data = await handlers.rest({ method, endpoint: url.pathname.slice(1) + url.search, body });
      } else {
        assert.equal(method, "GET");
        assert.equal(url.pathname, `/users/${selectedConfig.owner}`);
        data = { type: "User", node_id: "OWNER_fixture" };
      }
      if (data instanceof Response) return data;
      return Response.json(data, { headers: {
        "x-github-request-id": "fixture-request", "x-ratelimit-resource": url.pathname === "/graphql" ? "graphql" : "core",
        "x-ratelimit-remaining": "5000", "x-ratelimit-limit": "5000", "x-ratelimit-used": "0",
        "x-ratelimit-reset": "2051222400",
      } });
    },
  });
}

export function projectData(id: string, number = config.project.number, fields: readonly unknown[] = []) {
  const pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null };
  return { user: { projectV2: { id, number, title: config.project.title, public: true, closed: false,
    url: `https://github.com/users/${config.owner}/projects/${number}`,
    fields: { totalCount: fields.length, nodes: fields, pageInfo } } } };
}
