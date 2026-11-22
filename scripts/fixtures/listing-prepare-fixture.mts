/** A stand-in Core CLI for preparation tests that run without a Rust build.
 * It implements only what `prepareObservationBundle` calls: format export,
 * directory validation, publication inspection and capabilities. Its one
 * validation rule mirrors Core's: an observation with an unknown field is
 * refused. Real Core validation is exercised by the rehearsal with `--cli`. */
import { chmodSync, writeFileSync } from "node:fs";

const stubObservationFields = [
  "provider",
  "repository",
  "repository_id",
  "status",
  "attempted_at",
  "observed_at",
  "fresh_until",
  "facts_sha256",
  "release_limit",
  "releases",
];

export function writeStubCli(file: string) {
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const args = process.argv.slice(2);
const allowed = new Set(${JSON.stringify(stubObservationFields)});
const fail = (message) => { process.stdout.write(JSON.stringify({ ok: false, error: message })); process.exit(1); };
const validate = (directory) => {
  for (const row of directory.listings)
    if (row.upstream_observation && Object.keys(row.upstream_observation).some((key) => !allowed.has(key)))
      fail("unknown field in upstream_observation of " + row.id);
};
const ok = (command, data) => process.stdout.write(JSON.stringify({ ok: true, command, data }));
if (args[1] === "capabilities")
  ok("capabilities", { product: "Portcove", product_version: "stub", listing_formats: [11, 12, 13, 14, 15],
    listing_delivery_carriers: ["json-v1", "gzip-base64-json-v1"] });
else if (args[1] === "catalog" && args[2] === "inspect-listings") {
  const directory = JSON.parse(fs.readFileSync(args[4], "utf8"));
  const format = args[5] === "--format-version" ? Number(args[6]) : null;
  if (format === null) { validate(directory); ok("inspect-listings", directory); }
  else {
    const listings = directory.listings.map((source) => {
      const row = { ...source };
      if (format < 15) delete row.restrictions;
      if (format < 12) delete row.implementation;
      return row;
    });
    ok("inspect-listings", { ...directory, format_version: format, listings });
  }
} else if (args[1] === "catalog" && args[2] === "inspect-definition-publication") {
  const root = args[3];
  const legacy = JSON.parse(fs.readFileSync(path.join(root, "policy/official/catalog.listings.json"), "utf8"));
  validate(legacy.directory);
  const compactPath = path.join(root, "policy/official/catalog.listings.compact.json");
  if (fs.existsSync(compactPath)) {
    const wire = JSON.parse(fs.readFileSync(compactPath, "utf8"));
    validate(JSON.parse(zlib.gunzipSync(Buffer.from(wire.gzip_base64, "base64")).toString("utf8")).directory);
  }
  ok("inspect-definition-publication", {});
} else fail("unsupported stub command " + args.join(" "));
`,
  );
  chmodSync(file, 0o755);
  return file;
}
