import { expect, it } from "vite-plus/test";
import {
  inboxStateMessage,
  sourceDiscoveryLimitGuidance,
  sourceDiscoveryLimitLabel,
  sourceDiscoveryResultSummary,
} from "./SourceDiscovery";
it("describes known folder-search states and leaves unknown states unexplained", () => {
  expect(inboxStateMessage("exact_match")).toBe("An exact match is available.");
  expect(inboxStateMessage("approval_required")).toBe("A possible match needs your review.");
  expect(inboxStateMessage("future_state" as Parameters<typeof inboxStateMessage>[0])).toBe(
    "Search result unavailable.",
  );
});

it("presents source discovery counts and limits in player-facing language", () => {
  expect(sourceDiscoveryResultSummary(0, 0, 0)).toBe(
    "Found no exact matches. Checked no files or folders (0 B of verification data).",
  );
  expect(sourceDiscoveryResultSummary(1, 1, 64)).toBe(
    "Found 1 exact match. Checked 1 file or folder (64 B of verification data).",
  );
  expect(sourceDiscoveryResultSummary(2, 1_000, 1024)).toBe(
    "Found 2 exact matches. Checked 1,000 files and folders (1.0 KiB of verification data).",
  );
  const limits = ["entries", "depth", "file_size", "hash_bytes", "candidates"];
  expect(limits.map((limit) => sourceDiscoveryLimitLabel(limit, "folder"))).toEqual([
    "File and folder count",
    "Folder depth",
    "Individual file size",
    "Verification data",
    "Result count",
  ]);
  expect(limits.map((limit) => sourceDiscoveryLimitLabel(limit, "inbox"))).toEqual([
    "File and folder count",
    "Folder depth",
    "Individual file size",
    "Verification data",
    "Possible matches checked",
  ]);
  expect(sourceDiscoveryLimitLabel("future_limit")).toBe("Another search safety limit");
  expect(sourceDiscoveryLimitGuidance("entries", "folder")).toBe(
    "Choose a smaller folder and search again.",
  );
  expect(sourceDiscoveryLimitGuidance("entries", "inbox")).toContain(
    "temporarily move some files outside it",
  );
  expect(sourceDiscoveryLimitGuidance("depth", "inbox")).toContain(
    "move deeply nested files closer to its root",
  );
  expect(sourceDiscoveryLimitGuidance("depth", "folder")).toContain(
    "deeper folder as the search root",
  );
  expect(sourceDiscoveryLimitGuidance("file_size")).toContain("2.0 GiB");
  expect(sourceDiscoveryLimitGuidance("file_size")).toContain(
    "does not identify which file hit this limit",
  );
  expect(sourceDiscoveryLimitGuidance("hash_bytes")).toContain("16.0 GiB");
  expect(sourceDiscoveryLimitGuidance("hash_bytes")).toContain("verification-work budget");
  expect(sourceDiscoveryLimitGuidance("hash_bytes", "inbox")).toContain(
    "temporarily move some files outside it",
  );
  expect(sourceDiscoveryLimitGuidance("candidates", "inbox")).toContain("possible matches shown");
  expect(sourceDiscoveryLimitGuidance("candidates", "inbox")).toContain(
    "temporarily move some files outside it",
  );
  expect(sourceDiscoveryLimitGuidance("candidates", "inbox")).not.toContain("Search this folder");
  expect(sourceDiscoveryLimitGuidance("future_limit")).toBe(
    "Review the search limits and try a narrower search.",
  );
});
