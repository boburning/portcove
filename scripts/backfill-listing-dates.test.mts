import assert from "node:assert/strict";
import test from "node:test";
import { firstAddedSeconds, insertListedAt, utcDate } from "./backfill-listing-dates.mts";
import { isCalendarDate } from "./catalog-authoring.mts";

void test("dates are the UTC calendar day of the commit, not the local one", () => {
  // 2026-11-09T23:59:59Z and the first second of the next day.
  assert.equal(utcDate(Date.UTC(2026, 10, 9, 23, 59, 59) / 1000), "2026-11-09");
  assert.equal(utcDate(Date.UTC(2026, 10, 10, 0, 0, 0) / 1000), "2026-11-10");
});

void test("the earliest add commit wins even when a file is re-added later", () => {
  const log = [
    "300",
    "ports/a.json",
    "",
    "200",
    "ports/b.json",
    "ports/a.json",
    "",
    "100",
    "ports/b.json",
  ].join("\n");
  const earliest = firstAddedSeconds(log);
  assert.equal(earliest.get("ports/a.json"), 200);
  assert.equal(earliest.get("ports/b.json"), 100);
});

const parsed = (text: string) => JSON.parse(text) as { listing: { listed_at?: string } };

const listing = (extra: string) =>
  `{\n  "format_version": 1,\n  "listing": {\n    "id": "x",\n    "project_url": "https://github.com/a/b",\n${extra}    "availability": "packages"\n  }\n}\n`;

void test("the date follows issue_number when there is one, otherwise project_url", () => {
  const withIssue = insertListedAt(listing('    "issue_number": 58,\n'), "2026-11-09");
  assert.match(
    withIssue,
    /"issue_number": 58,\n {4}"listed_at": "2026-11-09",\n {4}"availability"/u,
  );
  const without = insertListedAt(listing(""), "2026-11-09");
  assert.match(
    without,
    /"project_url": "https:\/\/github.com\/a\/b",\n {4}"listed_at": "2026-11-09",/u,
  );
  assert.doesNotThrow(() => JSON.parse(withIssue));
  assert.equal(parsed(without).listing.listed_at, "2026-11-09");
});

void test("an existing date is kept and a nested key of the same name is not mistaken for it", () => {
  const dated = listing('    "listed_at": "2020-01-01",\n');
  assert.equal(insertListedAt(dated, "2026-11-09"), dated);
  // Only the listing's own four-space key counts.
  const nested = `{\n  "listing": {\n    "id": "x",\n    "project_url": "u",\n    "manual_setup": {\n      "listed_at": "n"\n    },\n    "availability": "packages"\n  }\n}\n`;
  assert.equal(parsed(insertListedAt(nested, "2026-11-09")).listing.listed_at, "2026-11-09");
});

void test("early years are real dates, matching the Rust validator", () => {
  assert.ok(isCalendarDate("0050-06-15"));
  assert.ok(!isCalendarDate("0050-02-29"), "year 50 is not a leap year");
  assert.ok(isCalendarDate("0004-02-29"), "year 4 is a leap year");
});

void test("only real calendar dates are accepted", () => {
  for (const good of ["2026-11-09", "2024-02-29", "2000-01-01"])
    assert.ok(isCalendarDate(good), good);
  for (const bad of [
    "2026-13-01",
    "2026-02-30",
    "2025-02-29",
    "2026-1-9",
    "2026-11-09T00:00:00Z",
    "",
    "x",
  ])
    assert.ok(!isCalendarDate(bad), bad);
  assert.throws(() => insertListedAt(listing(""), "2026-02-30"));
});
