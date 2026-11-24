/**
 * The part of a release's own text the generated-registration release-text
 * rule reads, shared by the upstream observer (which keeps only that part)
 * and the rule (`catalog-generated-registration.mts`), so both read a body
 * the same way. No dependencies: the observer imports it.
 */

/**
 * Whether one whitespace-free token is a compare range (`v0.9-beta...v1.0`,
 * as in GitHub's generated "Full Changelog" line, or `1.0-beta...1.0`): it
 * holds a run of two or three dots with a digit both before and after that
 * run. `Beta...`, `Beta... finally` and `beta...v2` are no range: the text
 * before the dots holds no digit, so the status word stays. Linear in the
 * token.
 */
export function compareRange(token: string): boolean {
  const start = token.indexOf("..");
  if (start <= 0) return false;
  let end = start;
  while (token[end] === ".") end++;
  const dots = end - start;
  return (
    dots >= 2 &&
    dots <= 3 &&
    end < token.length &&
    /[0-9]/u.test(token.slice(0, start)) &&
    /[0-9]/u.test(token.slice(end))
  );
}

/**
 * Release text with what never states anything about the release removed:
 * image references (`![alt](beta.png)`), HTML tags, link targets (the link
 * text stays), URLs, compare ranges (`compareRange`) and image file names.
 */
export function statementText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/gu, " ")
    .replace(/(?<![A-Za-z0-9])www\.\S*/giu, " ")
    .replace(/\S+/gu, (token) => (compareRange(token) ? " " : token))
    .replace(/\S+\.(?:png|jpe?g|gif|webp|svg|ico|bmp)(?![A-Za-z0-9])/giu, " ");
}

/**
 * HTML elements that end a line where they open or close (`<br>`, `<p>`,
 * `</div>`, list items, headings, table rows, block quotes, preformatted
 * blocks and rules): pasted HTML notes break lines with these, not with line
 * breaks.
 */
const lineBreakingElements = new Set([
  "br",
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "table",
  "blockquote",
  "pre",
  "hr",
]);

/**
 * The body with every HTML tag removed, also one that spans lines (an
 * `<img` whose attributes continue on the next line): a line-breaking
 * element (`lineBreakingElements`) becomes a line break, any other tag a
 * space. A `<` with no later `>` is text. Linear in the body.
 */
export function withoutTags(body: string): string {
  let result = "";
  let at = 0;
  for (;;) {
    const open = body.indexOf("<", at);
    if (open < 0) break;
    const close = body.indexOf(">", open + 1);
    if (close < 0) break;
    const name = /^\/?\s*([A-Za-z][A-Za-z0-9]*)/u.exec(body.slice(open + 1, close))?.[1];
    result +=
      body.slice(at, open) +
      (name !== undefined && lineBreakingElements.has(name.toLowerCase()) ? "\n" : " ");
    at = close + 1;
  }
  return result + body.slice(at);
}

/**
 * The line of a release body that is judged: the first line of the whole
 * body that holds a letter or digit once tags (`withoutTags`) and what states
 * nothing (`statementText`) are removed and leading Markdown heading, quote,
 * list and emphasis marks are trimmed; null when there is none. A banner
 * image, a bare link line or the attributes of a tag never become the
 * judged line, and the whole line is judged, however long.
 */
export function bodyFirstLine(body: string): string | null {
  for (const raw of withoutTags(body).split(/\r?\n|\r/u)) {
    const line = statementText(raw)
      .replace(/^[\s#>*_=~`-]+/u, "")
      .trim();
    if (/[A-Za-z0-9]/u.test(line)) return line;
  }
  return null;
}
