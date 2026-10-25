import { Session } from "node:inspector";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  readCoveragePacket,
  boundedCoverageRead,
  assertCoverageCustody,
} from "./test-coverage-config.mts";
import { retainCoverageMap } from "./coverage-maps.mts";

const filename = process.env.PORTCOVE_NODE_COVERAGE_PACKET;
if (!filename) throw new Error("Coverage observer requires its source packet");
const packet = readCoveragePacket(process.cwd(), filename);
const key = (file: string) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const selected = new Set(packet.request.modules.map((file) => key(path.join(packet.root, file))));
const session = new Session();
let refused = false;
session.connect();
// This boundary observes V8's final compiled source, including code changed by later load hooks.
session.on("Debugger.scriptParsed", ({ params }) => {
  if (refused || !params.url.startsWith("file:") || !selected.has(key(fileURLToPath(params.url))))
    return;
  session.post("Debugger.getScriptSource", { scriptId: params.scriptId }, (error, result) => {
    try {
      if (error) throw error;
      const file = fileURLToPath(params.url);
      const original = boundedCoverageRead(file, 1024 * 1024).toString("utf8");
      const typescript = /\.[cm]?ts$/u.test(file);
      const stripped = typescript ? stripTypeScriptTypes(original, { mode: "strip" }) : original;
      if (original.length !== stripped.length)
        throw new Error("Type stripping changed source positions");
      for (let index = 0; index < original.length; index++) {
        if (
          original[index] !== stripped[index] &&
          (!/\s/u.test(stripped[index]!) ||
            /[\r\n]/u.test(original[index]!) ||
            /[\r\n]/u.test(stripped[index]!))
        )
          throw new Error("Type stripping changed source positions");
      }
      const generated = result.scriptSource;
      const tail = generated.slice(stripped.length);
      if (
        !generated.startsWith(stripped) ||
        (tail !== "" && tail !== `\n\n//# sourceURL=${params.url}`)
      )
        throw new Error("Compiled coverage source differs from the retained original mapping");
      retainCoverageMap(
        packet,
        file,
        generated,
        {
          kind: "identity-utf16-offsets",
          mapped_prefix_length: original.length,
          generated_length: generated.length,
          unmapped_tail: tail,
          rule: "Runtime code units in the mapped prefix retain their original UTF-16 offsets; removed type syntax is whitespace; newline positions are unchanged. The optional Node sourceURL comment tail is unmapped.",
          transform: typescript
            ? `node:${process.version}:stripTypeScriptTypes:strip`
            : "byte-identical JavaScript",
        },
        "node-v8-compiled-script",
      );
    } catch (failure) {
      refused = true;
      assertCoverageCustody(packet);
      writeFileSync(
        path.join(packet.directory, `mapping-failure-${process.pid}.json`),
        JSON.stringify({ error: String(failure) }) + "\n",
        { flag: "wx" },
      );
      process.exitCode = 1;
    }
  });
});
session.post("Debugger.enable");
