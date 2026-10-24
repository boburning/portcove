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
