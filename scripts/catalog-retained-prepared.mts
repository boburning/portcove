import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogSource } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

export const retainedPreparedEnrollment = "retained-prepared-enrollment.json";
const fixtureName = /^[a-z0-9-]+-retained-selected-\d{4}-\d{2}-\d{2}\.json$/u;
const portId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const testName = /^[a-z][a-z0-9_]*$/u;

function readJson(root: string, name: string) {
  const file = join(root, name);
  const info = lstatSync(file);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error(`Retained prepared test input must be a bounded regular file: ${name}`);
  return parseCatalogSource(readFileSync(file, "utf8"));
}

export function renderRetainedPreparedTests(root: string) {
  const expected = new Map<string, string>();
  const fixtures = readdirSync(root).filter((file) => fixtureName.test(file));
  if (fixtures.length > 256) throw new Error("Too many retained prepared fixtures");
  for (const name of fixtures) {
    const fixture = readJson(root, name);
    if (
      !isRecord(fixture) ||
      !Array.isArray(fixture.ports) ||
      fixture.ports.length === 0 ||
      fixture.ports.length > 256
    )
      throw new Error(`Retained prepared fixture needs a port inventory: ${name}`);
    for (const port of fixture.ports) {
      if (
        !isRecord(port) ||
        typeof port.id !== "string" ||
        !portId.test(port.id) ||
        !isRecord(port.release) ||
        port.release.provider !== "user-prepared" ||
        expected.has(port.id)
      )
        throw new Error(`Invalid or duplicate retained prepared port in ${name}`);
      expected.set(port.id, name);
    }
  }
  const manifest = readJson(root, retainedPreparedEnrollment);
  if (
    !isRecord(manifest) ||
    manifest.format_version !== 1 ||
    !Array.isArray(manifest.cases) ||
    Object.keys(manifest).length !== 2
  )
    throw new Error("Invalid retained prepared test enrollment");
  const names = new Set<string>();
  const cases = manifest.cases.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.port_id !== "string" ||
      typeof entry.fixture !== "string" ||
      expected.get(entry.port_id) !== entry.fixture ||
      Object.keys(entry).some((key) => !["port_id", "fixture", "test_name"].includes(key))
    )
      throw new Error("Retained prepared enrollment does not match the fixture inventory");
    const name = entry.test_name ?? `retained_prepared_${entry.port_id.replaceAll("-", "_")}`;
    if (typeof name !== "string" || name.length > 256 || !testName.test(name) || names.has(name))
      throw new Error("Invalid or duplicate retained prepared test name");
    names.add(name);
    expected.delete(entry.port_id);
    return { id: entry.port_id, fixture: entry.fixture, name };
  });
  if (expected.size) throw new Error("Retained prepared fixture is missing test enrollment");

  const arms = cases.map(({ id, fixture }) => {
    const expression = `Some(include_str!("${fixture}"))`;
    const inline = `        "${id}" => ${expression},`;
    return inline.length <= 100
      ? `${inline}\n`
      : `        "${id}" => {\n            ${expression}\n        }\n`;
  });
  const wrappers = cases.map(
    ({ id, name }) =>
      `#[test]\nfn ${name}() {\n    assert_prepared_player_route("${id}", None);\n}\n`,
  );
  return `// Retained prepared tests are generated from independent fixture enrollment.\nfn retained_prepared_definition(id: &str) -> Option<&'static str> {\n    match id {\n${arms.join("")}        _ => None,\n    }\n}\n\n${wrappers.join("\n")}`;
}
