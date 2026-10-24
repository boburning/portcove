import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ArtworkCatalog } from "../inspect-igdb-artwork.mts";
import { isRecord } from "../runtime-values.mts";
import { authoringRecordFromPort } from "../catalog-authoring.mts";
import { fileURLToPath, pathToFileURL } from "node:url";

export function requiredFixture<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "Required fixture value is missing");
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected fixture object");
  return value;
}

export function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Expected fixture array");
  const items: unknown[] = value;
  return items.map(record);
}

export function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  const items: unknown[] = value;
  return items.map(text);
}

export function text(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error("Expected fixture text");
  return value;
}

export function fixtureJson(bytes: string | Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString());
  return record(value);
}

interface FixtureRecord extends Record<string, unknown> {
  id: string;
}

interface FixturePort extends FixtureRecord {
  release?: Record<string, unknown>;
  presentation?: Record<string, unknown> | null;
  executable_hints?: Record<string, unknown>;
}

export interface FixtureCatalog extends ArtworkCatalog {
  ports: FixturePort[];
  source_catalog: Record<
    "identities" | "contracts" | "validators" | "evidence",
    FixtureRecord[]
  > & {
    qualification: Record<string, unknown>[];
  };
}

export function fixtureCatalog(value: unknown): FixtureCatalog {
  function assertCatalog(value: unknown): asserts value is FixtureCatalog {
    const catalog = record(value);
    for (const port of records(catalog.ports)) {
      text(port.id);
      for (const field of ["release", "presentation", "executable_hints"])
        if (port[field] !== undefined && !(field === "presentation" && port[field] === null))
          record(port[field]);
    }
    const source = record(catalog.source_catalog);
    for (const field of ["identities", "contracts", "validators", "evidence"])
      for (const item of records(source[field])) text(item.id);
    records(source.qualification);
  }
  assertCatalog(value);
  return value;
}

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const catalogRoot = join(root, "crates", "portcove-core", "catalog");

export function run(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/generate-catalog.mts", ...args], {
    cwd: root,
    encoding: "utf8",
    // Complete historical comparisons exceed Node's default 1 MiB capture.
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function isolatedGenerator() {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-generator-dispatch-"));
  mkdirSync(join(scratch, "scripts"));
  for (const name of [
    "generate-catalog.mts",
    "inspect-igdb-artwork.mts",
    "runtime-values.mts",
    "catalog-authoring.mts",
    "upstream-lineage.mts",
    "catalog-authoring-inspector.mts",
    "maintainer-config.mts",
  ])
    copyFileSync(join(root, "scripts", name), join(scratch, "scripts", name));
  const catalogs = join(scratch, "crates", "portcove-core", "catalog");
  mkdirSync(catalogs, { recursive: true });
  for (const name of [
    "catalog-current-authoring.json",
    "catalog-schema2-migration-fixture.json",
    "catalog-schema1-fixture.json",
    "catalog-legacy-additions-fixture.json",
  ])
    copyFileSync(join(catalogRoot, name), join(catalogs, name));
  syncFixtureSource(catalogs);
  return {
    scratch,
    catalogs,
    run: (...args: string[]) => {
      // These historical tests author a complete fixture proposal. Assemble its
      // source records explicitly; production never reads the aggregate as source.
      syncFixtureSource(catalogs);
      return spawnSync(process.execPath, ["scripts/generate-catalog.mts", ...args], {
        cwd: scratch,
        encoding: "utf8",
      });
    },
  };
}

function syncFixtureSource(catalogs: string) {
  const input = fixtureCatalog(
    fixtureJson(readFileSync(join(catalogs, "catalog-current-authoring.json"))),
  );
  const shared: Record<string, unknown> = structuredClone(input);
  delete shared.ports;
  writeFileSync(join(catalogs, "catalog-shared.json"), JSON.stringify(shared));
  const directory = join(catalogs, "ports");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
  const seen = new Set();
  for (const [index, port] of input.ports.entries()) {
    const name = seen.has(port.id) ? `duplicate-${index}` : port.id;
    seen.add(port.id);
    writeFileSync(
      join(directory, `${name}.json`),
      JSON.stringify(authoringRecordFromPort(port, index)),
    );
  }
}

export function proposalDecoderFixture(
  images = 0,
  failInitialization = false,
  mode = "--prepare-proposal",
  editInput?: (input: FixtureCatalog, catalogs: string) => void,
) {
  const fixture = isolatedGenerator();
  if (editInput) {
    const path = join(fixture.catalogs, "catalog-current-authoring.json");
    const input = fixtureCatalog(fixtureJson(readFileSync(path)));
    editInput(input, fixture.catalogs);
    writeFileSync(path, JSON.stringify(input));
  }
  const helper = join(fixture.scratch, "scripts", "inspect-igdb-artwork.mts");
  copyFileSync(helper, join(fixture.scratch, "scripts", "real-artwork.mts"));
  writeFileSync(
    helper,
    `
    export { readArtworkJson, readArtworkInput } from './real-artwork.mts';
    import { createCoreImageValidator as actualValidator } from './real-artwork.mts';
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    export function createCoreImageValidator(cli, root) {
      appendFileSync(process.env.FIXTURE_FACTORY_LOG, JSON.stringify({cli,
        sha256:createHash('sha256').update(readFileSync(cli)).digest('hex')})+'\\n');
      if(process.env.FIXTURE_FAIL_INITIALIZATION==='yes') throw new Error('inert initialization failure');
      return actualValidator(cli, root);
    }
    export function createIgdbInspector(_credentials, validateImage) {
      return {validateImage,providerMetrics:{authentication_requests:0,game_requests:0,image_requests:0}};
    }
    export async function prepareCatalogArtwork(input, {validateImage}) {
      const records=[];
      for(let i=0;i<Number(process.env.FIXTURE_IMAGES);i++) {
        try { records.push(validateImage(Buffer.from('inert image '+i))); }
        catch { records.push({failure:true}); }
      }
      return {catalog:input,records,metrics:{}};
    }
  `,
  );
  const cli = join(fixture.scratch, "selected-cli");
  const original = Buffer.from("inert first-party validator fixture");
  writeFileSync(cli, original);
  const preload = join(fixture.scratch, "process fixture #% ü.mjs");
  writeFileSync(
    preload,
    `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    let calls=0;
    cp.spawnSync=(artifact,args)=>{
      const bytes=readFileSync(args.at(-1));
      const sha256=createHash('sha256').update(bytes).digest('hex');
      const inspection=args.includes('inspect-proposal');
      appendFileSync(process.env.FIXTURE_PROCESS_LOG,JSON.stringify({artifact,inspection})+'\\n');
      if(++calls===1 && inspection)writeFileSync(process.env.FIXTURE_SELECTED_CLI,'selected file changed after capture');
      const data=inspection?{format_version:1,input_sha256:sha256,input_bytes:bytes.length,ports:[]}
        :{selection:{sha256,byte_size:bytes.length,width:1,height:1,format:'jpeg'}};
      return {status:0,signal:null,stdout:JSON.stringify({data}),stderr:''};
    };
    syncBuiltinESMExports();
  `,
  );
  const output = join(fixture.scratch, "output");
  const factoryLog = join(fixture.scratch, "factory.log");
  const processLog = join(fixture.scratch, "process.log");
  syncFixtureSource(fixture.catalogs);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "scripts/generate-catalog.mts",
      mode,
      join(fixture.catalogs, "catalog-current-authoring.json"),
      "--validator-cli",
      cli,
      "--output-dir",
      output,
    ],
    {
      cwd: fixture.scratch,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        FIXTURE_SELECTED_CLI: cli,
        FIXTURE_IMAGES: String(images),
        FIXTURE_FAIL_INITIALIZATION: failInitialization ? "yes" : "no",
        FIXTURE_FACTORY_LOG: factoryLog,
        FIXTURE_PROCESS_LOG: processLog,
      },
    },
  );
  return {
    result,
    output,
    catalogs: fixture.catalogs,
    original,
    cli,
    factories: existsSync(factoryLog)
      ? readFileSync(factoryLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => fixtureJson(line))
      : [],
    processes: existsSync(processLog)
      ? readFileSync(processLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => fixtureJson(line))
      : [],
  };
}
