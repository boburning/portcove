/**
 * The part of a release's own text the generated-registration release-text
 * rule reads, shared by the upstream observer (which keeps only that part)
 * and the rule (`catalog-generated-registration.mts`), so both read a body
 * the same way. No dependencies: the observer imports it. Every step is
 * linear in the text, so untrusted text of any length is read in bounded
 * time.
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
 * The HTML elements GitHub renders in release notes (its sanitizer's
 * allowlist). Anything else written in angle brackets (`v1 <- Beta 2`,
 * `Windows < 10 Beta 3`, `<Beta 3>`) is shown as text, so it is read as text.
 */
export const renderedElements: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "b",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "g-emoji",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "source",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "ul",
  "var",
  "video",
  "wbr",
]);

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
 * A blank line: a line break, optional spaces or tabs, and another line
 * break (a lone CRLF is one line break).
 */
export const blankLine = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r|\n)/u;

/**
 * The text with HTML comments and tags removed. A comment is `<!--` to the
 * next `-->`. A tag is `<`, an optional `/`, a rendered element's name
 * (`renderedElements`, any case) followed by a space, `/` or `>`, then any
 * characters but `<` and `>` holding no blank line, then `>`; so a tag whose
 * attributes continue on the next line is one tag. Anything else stays text:
 * an unclosed comment, a `<` with no rendered name after it, or a span that
 * reaches another `<` or a blank line first. A line-breaking element
 * (`lineBreakingElements`) becomes `blockBreak`, anything else removed a
 * space. Linear in the text.
 */
function withoutMarkup(text: string, blockBreak: string): string {
  let result = "";
  let at = 0;
  let commentEnd = -2;
  let close = -2;
  for (let open = text.indexOf("<"); open >= 0; open = text.indexOf("<", open + 1)) {
    if (open < at) continue;
    if (text.startsWith("<!--", open)) {
      if (commentEnd !== -1 && commentEnd < open + 4) commentEnd = text.indexOf("-->", open + 4);
      if (commentEnd < 0) continue;
      result += `${text.slice(at, open)} `;
      at = commentEnd + 3;
      continue;
    }
    const name = /^\/?([A-Za-z][A-Za-z0-9-]*)/u.exec(text.slice(open + 1, open + 20))?.[1];
    if (name === undefined || !renderedElements.has(name.toLowerCase())) continue;
    const after = open + 1 + (text[open + 1] === "/" ? 1 : 0) + name.length;
    if (after >= text.length || !/[\s/>]/u.test(text[after]!)) continue;
    if (close !== -1 && close < after) close = text.indexOf(">", after);
    if (close < 0) continue;
    // Another `<` first: this is no tag. Checked before the blank line, so
    // no text is searched for a blank line twice.
    const next = text.indexOf("<", after);
    if ((next >= 0 && next < close) || blankLine.test(text.slice(after, close))) continue;
    result +=
      text.slice(at, open) + (lineBreakingElements.has(name.toLowerCase()) ? blockBreak : " ");
    at = close + 1;
  }
  return result + text.slice(at);
}

/**
 * The body with HTML comments and tags removed (`withoutMarkup`), a
 * line-breaking element becoming a line break.
 */
export function withoutTags(body: string): string {
  return withoutMarkup(body, "\n");
}

/**
 * The token with a URL removed: from the first letter that starts an
 * unbroken run of scheme characters (`[A-Za-z0-9+.-]`) ending at `://`, to
 * the token's end. Linear in the token.
 */
function withoutUrl(token: string): string {
  for (let at = token.indexOf("://"); at >= 0; at = token.indexOf("://", at + 1)) {
    let start = at;
    while (start > 0 && /[A-Za-z0-9+.-]/u.test(token[start - 1]!)) start--;
    while (start < at && !/[A-Za-z]/u.test(token[start]!)) start++;
    if (start < at) return `${token.slice(0, start)} `;
  }
  return token;
}

/**
 * The token with a `www.` address removed: from the first `www.` (any case)
 * not preceded by a letter or digit, to the token's end. Linear in the token.
 */
function withoutWww(token: string): string {
  // Matched on the token itself: lowercasing can change a string's length
  // (`İ`), which would shift every position after it.
  const at = /(?<![A-Za-z0-9])www\./iu.exec(token)?.index;
  return at === undefined ? token : `${token.slice(0, at)} `;
}

/**
 * The token with an image file name removed: everything up to the last image
 * extension (`.png`, `.jpg`, …) that has a character before it and no letter
 * or digit after it. Linear in the token.
 */
function withoutImageName(token: string): string {
  let end = -1;
  for (const match of token.matchAll(/\.(?:png|jpe?g|gif|webp|svg|ico|bmp)(?![A-Za-z0-9])/giu))
    if (match.index >= 1) end = match.index + match[0].length;
  return end < 0 ? token : ` ${token.slice(end)}`;
}

/** For each index, the index of the next `character` at or after it, or -1. */
function nextIndexes(text: string, character: string): Int32Array {
  const next = new Int32Array(text.length + 2).fill(-1);
  for (let index = text.length - 1; index >= 0; index--)
    next[index] = text[index] === character ? index : next[index + 1]!;
  return next;
}

/**
 * The text with each bracketed construct replaced, scanning left to right:
 * at `opener`, the text up to the next `]`, then `follow`, then up to the
 * next `closer` (`![alt](target)`, `[text](target)`, `[text][label]`).
 * `replace` receives the bracketed text. Linear in the text.
 */
function replaceBracketed(
  text: string,
  opener: string,
  follow: string,
  closer: string,
  replace: (inner: string) => string,
): string {
  const bracket = nextIndexes(text, "]");
  const closing = nextIndexes(text, closer);
  let result = "";
  let at = 0;
  for (let open = text.indexOf(opener); open >= 0; open = text.indexOf(opener, open + 1)) {
    if (open < at) continue;
    const end = bracket[open + opener.length]!;
    if (end < 0 || text[end + 1] !== follow) continue;
    const last = closing[end + 2]!;
    if (last < 0) continue;
    result += text.slice(at, open) + replace(text.slice(open + opener.length, end));
    at = last + 1;
  }
  return result + text.slice(at);
}

/** Each whitespace-free token of the text replaced by `replace`. */
const eachToken = (text: string, replace: (token: string) => string) =>
  text.replace(/\S+/gu, replace);

/**
 * Release text with what never states anything about the release removed:
 * image references (`![alt](beta.png)`), HTML comments and tags
 * (`withoutMarkup`), link targets (the link text stays), URLs, compare ranges
 * (`compareRange`) and image file names.
 */
export function statementText(line: string): string {
  let text = replaceBracketed(line, "![", "(", ")", () => " ");
  text = withoutMarkup(text, " ");
  text = replaceBracketed(text, "[", "(", ")", (inner) => inner);
  text = replaceBracketed(text, "[", "[", "]", (inner) => inner);
  text = eachToken(text, withoutUrl);
  text = eachToken(text, withoutWww);
  text = eachToken(text, (token) => (compareRange(token) ? " " : token));
  return eachToken(text, withoutImageName);
}

/**
 * The line of a release body that is judged: the first line of the whole
 * body that holds a letter or digit once comments and tags (`withoutTags`)
 * and what states nothing (`statementText`) are removed and leading Markdown
 * heading, quote, list and emphasis marks are trimmed; null when there is
 * none. A banner image, a bare link line or the attributes of a tag never
 * become the judged line, and the whole line is judged, however long.
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
