// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryMovePlan } from "../types";
import { LibraryCopySummary } from "./LibraryMove";

const fixture = (): LibraryMovePlan => ({
  source_root: "D:/Owned library",
  destination_root: "E:/New library",
  source_will_be_retained: true,
  required_bytes: 1000,
  available_bytes: 5000,
  plan_sha256: "reviewed-fingerprint",
  metadata: {
    schema_version: 3,
    exported_at: 1,
    original_root: "D:/Owned library",
    content_roots: [],
    port_settings: [],
    launch_history: [],
    application_versions: [
      {
        id: "owned-install",
        port_id: "owned-port",
        version: "1.2.3",
        path: "versions/owned-port/owned-install",
        channel: "stable",
        installed_at: 1,
        verified: true,
        staged: false,
        artifact: { asset_name: "owned.zip", sha256: "a".repeat(64), size: 1 },
        manifest_sha256: "b".repeat(64),
        selected_executable: "game.exe",
        runtime: null,
      },
    ],
    source_references: [
      {
        profile_id: "owned-disc",
        path: "D:/Owned library/source-inbox/disc.iso",
        sha256: "c".repeat(64),
        size: 64,
        storage_sha256: "c".repeat(64),
        storage_size: 64,
        updated_at: 1,
      },
    ],
  },
  content: [
    {
      kind: "user_data",
      relative_path: "user",
      copy: {
        directories: ["owned-port/empty-folder"],
        files: [
          {
            relative_path: "owned-port/save.bin",
            size: 10,
            sha256: "d".repeat(64),
          },
        ],
        total_bytes: 10,
        skipped_entries: [],
      },
    },
  ],
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (plan: LibraryMovePlan) =>
  act(async () =>
    root.render(
      <LibraryCopySummary
        plan={plan}
        source={plan.source_root}
        label="Library move plan"
      />,
    ),
  );
async function toggleFolder(open: boolean) {
  const details = host.querySelector("details")!;
  await act(async () => {
    details.open = open;
    details.dispatchEvent(new Event("toggle"));
  });
}

it.each([0, 1, 40])(
  "discloses all %s recorded files and empty folders without altering the plan",
  async (count) => {
    const plan = fixture();
    plan.content[0].copy.files = Array.from({ length: count }, (_, index) => ({
      relative_path: `owned-port/${"long-path-".repeat(12)}${index}.save`,
      size: index,
      sha256: "e".repeat(64),
    }));
    const original = JSON.stringify(plan);
    await render(plan);
    expect(host.querySelector('[aria-label="Files in user"]')).toBeNull();
    await toggleFolder(true);
    expect(
      host.querySelectorAll('[aria-label="Files in user"] li'),
    ).toHaveLength(count);
    for (const file of plan.content[0].copy.files)
      expect(host.textContent).toContain(file.relative_path);
    expect(host.textContent).toContain(
      count === 0
        ? "No files are recorded in this folder."
        : count === 1
          ? "1 file will be copied."
          : "40 files will be copied.",
    );
    expect(
      host.querySelector('[aria-label="Subfolders in user"]')?.textContent,
    ).toContain("owned-port/empty-folder");
    expect(host.querySelectorAll("button,a")).toHaveLength(0);
    expect(JSON.stringify(plan)).toBe(original);
    await toggleFolder(false);
    expect(host.querySelector('[aria-label="Files in user"]')).toBeNull();
  },
);

it.each(["future_kind", "constructor", "__proto__"])(
  "keeps an unfamiliar %s folder explicit and inspectable",
  async (kind) => {
    const plan = fixture();
    plan.content[0].kind = kind as LibraryMovePlan["content"][number]["kind"];
    await render(plan);
    expect(host.querySelector("summary")?.textContent).toContain(
      "Other recorded content",
    );
    await toggleFolder(true);
    expect(host.textContent).toContain(
      plan.content[0].copy.files[0].relative_path,
    );
  },
);

it("names the recorded installation and source paths without promising relocation or automatic undo", async () => {
  const plan = fixture();
  await render(plan);
  for (const value of [
    plan.source_root,
    plan.destination_root,
    "owned-port",
    "1.2.3",
    plan.metadata.application_versions[0].path,
    plan.metadata.source_references[0].path,
  ])
    expect(host.textContent).toContain(value);
  expect(host.textContent).toContain(
    "1 source registration keeps its recorded location.",
  );
  expect(host.textContent).toContain(
    "Copying Source Inbox files does not redirect their registrations.",
  );
  expect(host.textContent).toContain(
    "Original game files, saves, backups and artwork remain in place.",
  );
  expect(host.textContent).not.toContain("original files remain unchanged");
  expect(host.textContent).toContain("There is no single undo action");
  expect(host.textContent).toContain("this dialog cannot cancel it");
  expect(host.textContent).toContain(
    "use the recorded move or import recovery",
  );
});

it("replaces displayed inventory with the current plan and distinguishes empty metadata", async () => {
  const plan = fixture();
  await render(plan);
  await toggleFolder(true);
  const next = fixture();
  next.metadata.application_versions = [];
  next.metadata.source_references = [];
  next.content[0].copy.files[0].relative_path = "current-port/current.save";
  await render(next);
  expect(host.textContent).toContain("current-port/current.save");
  expect(host.textContent).not.toContain("owned-port/save.bin");
  expect(host.textContent).toContain(
    "No installed versions are recorded in this plan.",
  );
  expect(host.textContent).toContain("No source registrations are included.");
  expect(host.textContent).not.toContain("owned-disc");
});
