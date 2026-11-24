/**
 * The part of a release's own text the generated-registration release-text
 * rule reads, shared by the upstream observer (which keeps only that part)
 * and the rule (`catalog-generated-registration.mts`), so both read a body
 * the same way. No dependencies: the observer imports it.
 */

/**
 * The characters of a release body the rule reads: its first line that
 * holds a letter or digit is looked for only within them. A bounded unit:
 * when a body is longer and that line is not wholly inside them, the text
 * is unobserved for absence (never "states nothing").
 */
export const releaseBodyReadWindow = 4096;

/**
 * Release text with what never states anything about the release removed:
 * image references (`![alt](beta.png)`), HTML tags, link targets (the link
 * text stays), URLs, compare ranges (`v0.9-beta...v1.0`, as in a generated
 * "Full Changelog" line) and image file names.
 */
export function statementText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/gu, " ")
    .replace(/(?<![A-Za-z0-9])www\.\S*/giu, " ")
    .replace(/\S+\.{2,3}\S+/gu, " ")
    .replace(/\S+\.(?:png|jpe?g|gif|webp|svg|ico|bmp)(?![A-Za-z0-9])/giu, " ");
}

/**
 * The body's first line, within the first `releaseBodyReadWindow`
 * characters, that holds a letter or digit once what states nothing is
 * removed (`statementText`) and leading Markdown heading, quote, list and
 * emphasis marks are removed: both as written (`raw`) and as judged
 * (`line`), or null for both when there is none. `complete` says whether
 * that line was wholly read: a body longer than the window (`truncated`, or
 * its own length) is complete only when the line ended (a line break)
 * inside the window, or, with no such line, never.
 */
export function bodyFirstLineRead(
  body: string,
  truncated: boolean,
): { raw: string | null; line: string | null; complete: boolean } {
  const kept = body.slice(0, releaseBodyReadWindow);
  const cut = truncated || body.length > releaseBodyReadWindow;
  const lines = kept.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = statementText(raw)
      .replace(/^[\s#>*_=~`-]+/u, "")
      .trim();
    if (/[A-Za-z0-9]/u.test(line)) return { raw, line, complete: !cut || index < lines.length - 1 };
  }
  return { raw: null, line: null, complete: !cut };
}

/**
 * What of a body the observer keeps: the raw first line the rule judges
 * (`bodyFirstLineRead`), or empty text when there is none, and whether that
 * reading was cut (`truncated`). Reading the kept part again gives the same
 * line and the same completeness, so keeping only it never changes what the
 * rule finds.
 */
export function bodyExcerpt(body: string): { body: string; truncated: boolean } {
  const read = bodyFirstLineRead(body, false);
  return { body: read.raw ?? "", truncated: !read.complete };
}
