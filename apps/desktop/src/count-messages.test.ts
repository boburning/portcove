import { describe, expect, it } from "vitest";
import { formatCountMessage } from "./view-model";

const messages = {
  zero: "No versions moved.",
  one: "Moved {count} version.",
  other: "Moved {count} versions.",
  unknown: "Version count unavailable.",
};

describe("complete count messages", () => {
  it.each([
    [0, "No versions moved."],
    [1, "Moved 1 version."],
    [2, "Moved 2 versions."],
    [1_000_000, "Moved 1,000,000 versions."],
  ] as const)(
    "formats %s without concatenating grammatical fragments",
    (count, expected) => {
      expect(formatCountMessage(count, messages)).toBe(expected);
    },
  );
  it.each([
    undefined,
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("keeps unknown or invalid count %s explicit", (count) => {
    expect(formatCountMessage(count, messages)).toBe(
      "Version count unavailable.",
    );
  });
  it("uses the selected message language for grouping and plural categories", () => {
    const forms = {
      zero: "zero",
      one: "one {count}",
      few: "few {count}",
      many: "many {count}",
      other: "other {count}",
      unknown: "unknown",
    };
    expect(formatCountMessage(21, forms, "ru")).toBe("one 21");
    expect(formatCountMessage(2, forms, "ru")).toBe("few 2");
    expect(formatCountMessage(5, forms, "ru")).toBe("many 5");
    expect(formatCountMessage(1000, messages, "de")).toBe(
      "Moved 1.000 versions.",
    );
  });
  it("falls back to the complete other message for an omitted language category", () => {
    expect(formatCountMessage(2, messages, "ar")).toBe(
      `Moved ${new Intl.NumberFormat("ar").format(2)} versions.`,
    );
  });
});
