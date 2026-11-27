import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
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
import { authoringRecordFromPort, checkedAuthoredPort } from "../catalog-authoring.mts";
import { readFixtureModuleClosure } from "./module-closure.mts";
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
    // Keep a bounded capture with headroom for the complete historical comparison.
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function isolatedGenerator() {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-generator-dispatch-"));
  for (const module of readFixtureModuleClosure(root, ["scripts/generate-catalog.mts"]).modules) {
    const destination = join(scratch, module.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, module.bytes);
  }
  const catalogs = join(scratch, "crates", "portcove-core", "catalog");
  mkdirSync(catalogs, { recursive: true });
  // The committed aggregate is a generated output. Fixtures edit a scratch copy of it
  // and explode that into source records; production never reads an aggregate as source.
  // Generated registration routes come from listing facts, not authored
  // records; the historical fixtures assemble only the authored definitions.
  const generated = new Set(
    (
      JSON.parse(
        readFileSync(join(catalogRoot, "generated-registration.generated.json"), "utf8"),
      ) as { enrollments: { port_id: string }[] }
    ).enrollments.map(({ port_id }) => port_id),
  );
  const aggregate = JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8")) as {
    ports: { id: string }[];
  };
  writeFileSync(
    join(catalogs, "catalog-fixture-input.json"),
    generated.size
      ? `${JSON.stringify({ ...aggregate, ports: aggregate.ports.filter(({ id }) => !generated.has(id)) }, null, 2)}\n`
      : readFileSync(join(catalogRoot, "catalog.json")),
  );
  for (const name of [
    "catalog-schema2-migration-fixture.json",
    "catalog-schema1-fixture.json",
    "catalog-legacy-additions-fixture.json",
  ])
    copyFileSync(join(catalogRoot, name), join(catalogs, name));
  const testdata = join(scratch, "crates", "portcove-core", "src", "testdata");
  mkdirSync(testdata, { recursive: true });
  writeFileSync(
    join(testdata, "retained-prepared-enrollment.json"),
    '{"format_version":1,"cases":[]}',
  );
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
    fixtureJson(readFileSync(join(catalogs, "catalog-fixture-input.json"))),
  );
  const shared: Record<string, unknown> = structuredClone(input);
  delete shared.ports;
  writeFileSync(join(catalogs, "catalog-shared.json"), JSON.stringify(shared));
  const directory = join(catalogs, "ports");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
  const seen = new Set();
  const authoredDirectory = join(catalogRoot, "ports");
  const authoredNames = new Set(readdirSync(authoredDirectory));
  for (const [index, port] of input.ports.entries()) {
    const name = seen.has(port.id) ? `duplicate-${index}` : port.id;
    seen.add(port.id);
    const authored = authoringRecordFromPort(port, index);
    // Aggregate projections omit repository-only decisions. Preserve the actual
    // authored review for this exact existing port and source in the fixture.
    if (authoredNames.has(`${port.id}.json`)) {
      const original = checkedAuthoredPort(
        fixtureJson(readFileSync(join(authoredDirectory, `${port.id}.json`))),
        port.id,
      );
      if (original.original_game_review) {
        assert.equal(authored.integration?.source_profile, original.integration?.source_profile);
        authored.original_game_review = structuredClone(original.original_game_review);
      }
    }
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(authored));
  }
}

export function proposalDecoderFixture(
  images = 0,
  failInitialization = false,
  mode = "--prepare-proposal",
  editInput?: (input: FixtureCatalog, catalogs: string) => void,
  scene?: {
    portId: string;
    assets: Record<string, unknown>[];
    accepted?: Record<string, unknown>[];
    gone?: string[];
  },
) {
  const fixture = isolatedGenerator();
  if (editInput) {
    const path = join(fixture.catalogs, "catalog-fixture-input.json");
    const input = fixtureCatalog(fixtureJson(readFileSync(path)));
    editInput(input, fixture.catalogs);
    writeFileSync(path, JSON.stringify(input));
  }
  const helper = join(fixture.scratch, "scripts", "inspect-igdb-artwork.mts");
  copyFileSync(helper, join(fixture.scratch, "scripts", "real-artwork.mts"));
  writeFileSync(
    helper,
    `
    export { readArtworkJson, readArtworkInput, reconcileCatalogArtworkWithdrawals, assertPreparedArtwork, catalogGameMediaRoles, gameMediaImageTarget } from './real-artwork.mts';
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
    export async function prepareCatalogGameMedia(catalog) {
      if (!process.env.FIXTURE_MEDIA_SCENE) throw new Error('Game-media acquisition requires a fixture scene.');
      const { portId, assets, gone } = JSON.parse(process.env.FIXTURE_MEDIA_SCENE);
      const port = catalog.ports.find(({ id }) => id === portId);
      if (!port) throw new Error('Fixture scene has no port.');
      const updated = { ...port, presentation: { ...port.presentation, media: [...(port.presentation?.media ?? []), ...assets] } };
      return { catalog: assets.length ? { ...catalog, ports: catalog.ports.map((entry) => entry === port ? updated : entry) } : catalog, records: [], gone_media_targets: gone ?? [] };
    }
    // The generator may split a large catalog into several operations; the
    // fixture's images belong to the whole run, not to each operation.
    let fixtureImage=0;
    export async function prepareCatalogArtwork(input, {validateImage, selectedPortIds}) {
      const records=[];
      const port_id=(selectedPortIds ?? input.ports.map((port) => port.id))[0];
      for(;fixtureImage<Number(process.env.FIXTURE_IMAGES);fixtureImage++) {
        const i=fixtureImage;
        try { records.push({...validateImage(Buffer.from('inert image '+i)), port_id, reason:'fixture-decoder', mapping:null}); }
        catch { records.push({failure:true, port_id, reason:'fixture-decoder', mapping:null}); }
      }
      return {catalog:input,records,metrics:{game_queries:0,image_queries:0,image_bytes:0},gone_image_ids:[],
        workset:{catalog_ports:input.ports.length,selected_port_ids:[...(selectedPortIds ?? [])],invalidated_port_ids:[]}};
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
      const listings=args.includes('inspect-listings');
      const repository_authoring=args.includes('--repository-authoring');
      appendFileSync(process.env.FIXTURE_PROCESS_LOG,JSON.stringify({artifact,inspection,repository_authoring,...(listings?{listings}: {})})+'\\n');
      if(++calls===1 && inspection)writeFileSync(process.env.FIXTURE_SELECTED_CLI,'selected file changed after capture');
      if (inspection && JSON.parse(bytes).ports.some((port) => port.presentation?.media?.some((asset) => asset.igdb && ['header','screenshot'].includes(asset.role))))
        return { status: 2, signal: null, stdout: '{}', stderr: 'Typed scenes require a listing directory' };
      const data=listings?JSON.parse(bytes):inspection?{format_version:1,input_sha256:sha256,input_bytes:bytes.length,ports:[],scope:repository_authoring?'repository-summary-policy':'runtime-admission'}
        :{selection:{sha256,byte_size:bytes.length,width:1,height:1,format:'jpeg'}};
      if (listings) for (const listing of data.listings) if (listing.media?.length === 0) delete listing.media;
      return {status:0,signal:null,stdout:JSON.stringify({data}),stderr:''};
    };
    syncBuiltinESMExports();
  `,
  );
  const output = join(fixture.scratch, "output");
  const factoryLog = join(fixture.scratch, "factory.log");
  const processLog = join(fixture.scratch, "process.log");
  syncFixtureSource(fixture.catalogs);
  if (scene?.accepted) {
    const file = join(fixture.catalogs, "ports", `${scene.portId}.json`);
    const record = fixtureJson(readFileSync(file));
    if (!isRecord(record.listing)) throw new Error("Missing fixture media listing");
    record.listing.media = scene.accepted;
    writeFileSync(file, JSON.stringify(record));
  }
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "scripts/generate-catalog.mts",
      mode,
      join(fixture.catalogs, "catalog-fixture-input.json"),
      "--validator-cli",
      cli,
      "--output-dir",
      output,
      ...(scene ? ["--hero-media", "igdb", "--artwork-ids", scene.portId] : []),
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
        ...(scene ? { FIXTURE_MEDIA_SCENE: JSON.stringify(scene) } : {}),
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
