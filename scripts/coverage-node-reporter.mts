import type { TestEvent } from "node:test/reporters";
import { lcov } from "node:test/reporters";
import { Readable } from "node:stream";
import { writeFileSync } from "node:fs";
import path from "node:path";
import requiredReport from "./required-node-test-reporter.mts";
import {
  claimCoveragePacket,
  readCoveragePacket,
  assertCoverageCustody,
} from "./test-coverage-config.mts";

export default async function* coverageReport(source: AsyncIterable<TestEvent>) {
  const filename = process.env.PORTCOVE_NODE_COVERAGE_PACKET;
  if (!filename) throw new Error("Node coverage reporter requires its source packet");
  const packet = readCoveragePacket(process.cwd(), filename);
  if (packet.request.mode !== "node")
    throw new Error("Frontend packet cannot configure Node coverage");
  claimCoveragePacket(packet);
  async function* retain() {
    for await (const event of source) {
      if (event.type === "test:coverage") {
        assertCoverageCustody(packet);
        writeFileSync(
          path.join(packet.directory, "coverage", "node-coverage.json"),
          JSON.stringify(event.data, null, 2) + "\n",
          { flag: "wx" },
        );
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of Readable.from([event]).compose(lcov())) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          bytes += value.length;
          if (bytes > 32 * 1024 * 1024) throw new Error("LCOV report exceeds byte limit");
          chunks.push(value);
        }
        assertCoverageCustody(packet);
        writeFileSync(path.join(packet.directory, "coverage", "lcov.info"), Buffer.concat(chunks), {
          flag: "wx",
        });
      }
      yield event;
    }
  }
  yield* requiredReport(retain());
}
