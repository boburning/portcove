import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BackupHistory } from "../../components/BackupHistory";
import { failureReport, portDefinition } from "../../test-fixtures";

const port = portDefinition();

describe("backup history presentation", () => {
  it("keeps older backups reachable without expanding the detail panel by default", () => {
    const backups = Array.from({ length: 4 }, (_, index) => ({
      id: `backup-${index}`,
      port_id: port.id,
      path: `backups/sample/${index}`,
      created_at: index + 1,
      file_count: 1,
      size: 1024,
      sha256: `${index}`.repeat(64),
    }));
    const html = renderToStaticMarkup(
      <BackupHistory backups={backups} restore={vi.fn()} remove={vi.fn()} />,
    );
    expect(html).toContain("Backups");
    expect(html).toContain("Backups include saves and settings managed by Portcove.");
    expect(html).toContain("4 verified backups");
    expect(html).toContain("Show 1 older");
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*>[^]*?Show 1 older<\/button>/u);
    expect(html).not.toContain("backup-expander");
    for (const backup of backups.slice(0, 3))
      expect(html).toContain(
        `aria-label="Technical details for backup from ${new Date(backup.created_at * 1000).toLocaleString()}"`,
      );
    expect(html).not.toContain("3333333333");
  });

  it("uses count-aware backup wording and keeps checksum identity in technical details", () => {
    const backup = {
      id: "backup-1",
      port_id: port.id,
      path: "backups/sample/backup-1",
      created_at: 1,
      file_count: 1,
      size: 1024,
      sha256: "a".repeat(64),
    };
    const empty = renderToStaticMarkup(
      <BackupHistory backups={[]} restore={vi.fn()} remove={vi.fn()} />,
    );
    const populated = renderToStaticMarkup(
      <BackupHistory backups={[backup]} restore={vi.fn()} remove={vi.fn()} />,
    );
    expect(empty).toContain("No backups yet");
    expect(empty).not.toContain("snapshot");
    expect(populated).toContain("1 verified backup");
    expect(populated).toContain("1 file · 1.0 KiB");
    expect(populated).toContain("Technical details");
    expect(populated).toContain('aria-label="Technical details for backup from ');
    expect(populated).toContain('class="backup-checksum"');
    expect(populated.indexOf(backup.sha256)).toBeGreaterThan(populated.indexOf("<details"));
    expect(populated).not.toContain(`${backup.sha256.slice(0, 10)}…`);
  });

  it("keeps verified backups listed but blocks actions during required recovery", () => {
    const backups = [
      {
        id: "backup-1",
        port_id: port.id,
        path: "backups/sample/backup-1",
        created_at: 1,
        file_count: 2,
        size: 1024,
        sha256: "a".repeat(64),
      },
    ];
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={backups}
        state="recovery_required"
        problems={[
          {
            kind: "recovery_required",
            backup_id: null,
            operation_id: "operation-1",
            path: "backups/sample/.deleting-operation-1",
            message: "Deletion was interrupted.",
            proposed_action: "Restart Portcove, then review doctor output.",
          },
        ]}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).toContain("Backup recovery required");
    expect(html).toContain("1 verified backup");
    expect(html).toContain(
      "Verified backups remain listed, but restoring and deleting require recovery to finish.",
    );
    const actionButtons = Array.from(html.matchAll(/<button[^>]*>/gu), ([opening]) => opening);
    expect(actionButtons).toHaveLength(2);
    for (const opening of actionButtons) expect(opening).toContain('disabled=""');
    expect(html).toContain("What to do next");
    expect(html.indexOf("Restart Portcove, then review doctor output.")).toBeLessThan(
      html.indexOf("<details"),
    );
    expect(html).toContain("Technical details");
    expect(html).toContain("Deletion was interrupted");
    expect(html).toContain("Restore");
  });

  it("leaves verified backups actionable when another inventory entry is degraded", () => {
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={[
          {
            id: "backup-1",
            port_id: port.id,
            path: "backups/sample/backup-1",
            created_at: 1,
            file_count: 1,
            size: 1024,
            sha256: "a".repeat(64),
          },
        ]}
        state="degraded"
        problems={[
          {
            kind: "missing_manifest",
            backup_id: "backup-2",
            operation_id: null,
            path: "backups/sample/backup-2",
            message: "The other backup manifest is missing.",
            proposed_action: "Review the affected entry.",
          },
        ]}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).toContain("Verified backups remain listed and usable.");
    const actionButtons = Array.from(html.matchAll(/<button[^>]*>/gu), ([opening]) => opening);
    expect(actionButtons).toHaveLength(2);
    for (const opening of actionButtons) expect(opening).not.toContain('disabled=""');
  });

  it("names unusable backups honestly and shows each recovery action outside technical details", () => {
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={[]}
        state="degraded"
        problems={[
          {
            kind: "missing_manifest",
            backup_id: "backup-1",
            operation_id: null,
            path: "backups/sample/backup-1",
            message: "The manifest is missing.",
            proposed_action: "Review this entry before removing it.",
          },
          {
            kind: "unreadable_manifest",
            backup_id: "backup-2",
            operation_id: null,
            path: "backups/sample/backup-2",
            message: "The manifest cannot be read.",
            proposed_action: "Restore access, then check again.",
          },
        ]}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).toContain("Backups need attention");
    expect(html).toContain(
      "No backup is currently available to restore. Review the problems below.",
    );
    expect(html).not.toContain("No backups yet");
    expect(html).not.toContain("Restore</button>");
    expect(html.indexOf("What to do next")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("Review this entry before removing it.")).toBeLessThan(
      html.indexOf("<details"),
    );
    expect(html.indexOf("Restore access, then check again.")).toBeLessThan(
      html.indexOf("<details"),
    );
    expect(html.indexOf("backups/sample/backup-1")).toBeGreaterThan(html.indexOf("<details"));
    expect(html.indexOf("The manifest is missing.")).toBeGreaterThan(html.indexOf("<details"));
  });
});

it.each(["idle", "pending", "failed"] as const)(
  "keeps an unread %s list distinct from a current empty inventory",
  (status) => {
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={[]}
        readState={{ status, hasInventory: false }}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).not.toContain("No backups yet");
    expect(html).toContain(status === "pending" ? "Loading backup" : "Backup history unavailable");
  },
);

it.each(["pending", "failed"] as const)(
  "discloses a last-loaded empty list during a %s refresh",
  (status) => {
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={[]}
        readState={{ status, hasInventory: true }}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).toContain("Last-loaded backup list is empty");
    expect(html).toContain("last loaded backup list");
    expect(html).not.toContain("No backups yet");
  },
);

it("keeps a read failure's private diagnostics behind technical details without asserting a mutation outcome", () => {
  const failure = failureReport().presentation;
  failure.technical_message = "private/read/path: detailed failure";
  failure.technical_context = { path: "private/read/path" };
  const html = renderToStaticMarkup(
    <BackupHistory
      backups={[]}
      readState={{ status: "failed", hasInventory: false, failure }}
      retryRead={vi.fn()}
      restore={vi.fn()}
      remove={vi.fn()}
    />,
  );
  const primary = html.slice(0, html.indexOf("<details"));
  expect(primary).toContain("The backup list is unknown");
  expect(primary).not.toContain("private/read/path");
  expect(primary).not.toContain("whether anything changed");
  expect(primary).not.toContain("No files were changed");
  expect(primary).not.toContain("The change was saved");
  expect(html).toContain("private/read/path");
  expect(html).toContain("View technical details");
});
