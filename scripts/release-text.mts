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

/** Elements whose contents are never shown as text: removed with them. */
const rawTextElements = ["script", "style"] as const;

/**
 * The end of the whitespace at `at` in a tag: spaces and tabs with at most
 * one line ending among them (CommonMark's raw HTML whitespace).
 */
function tagSpace(text: string, at: number): number {
  while (text[at] === " " || text[at] === "\t") at++;
  if (text[at] === "\r" || text[at] === "\n") {
    at += text.startsWith("\r\n", at) ? 2 : 1;
    while (text[at] === " " || text[at] === "\t") at++;
  }
  return at;
}

/** The end of the run at `at` of characters `pattern` accepts. */
function runEnd(text: string, at: number, pattern: RegExp): number {
  while (at < text.length && pattern.test(text[at]!)) at++;
  return at;
}

/**
 * The end (after its `>`) of a raw HTML open or closing tag starting with
 * the `<` at `open`, and its lowercase name, or undefined. The grammar is
 * CommonMark's: a tag name (an ASCII letter, then letters, digits and `-`);
 * for an open tag, attributes (whitespace, a name of letters, digits, `_`,
 * `.`, `:` and `-` starting with a letter, `_` or `:`, optionally `=` and an
 * unquoted, single-quoted or double-quoted value), optional whitespace and an
 * optional `/`; then `>`. Whether GitHub renders the element does not matter:
 * it removes what it does not render, and shows neither as text.
 */
function rawTag(text: string, open: number): { end: number; name: string } | undefined {
  const closing = text[open + 1] === "/";
  const nameStart = open + (closing ? 2 : 1);
  if (!/[A-Za-z]/u.test(text[nameStart] ?? "")) return undefined;
  const nameEnd = runEnd(text, nameStart, /[A-Za-z0-9-]/u);
  const name = text.slice(nameStart, nameEnd).toLowerCase();
  let at = nameEnd;
  if (!closing)
    for (;;) {
      const space = tagSpace(text, at);
      if (space === at || !/[A-Za-z_:]/u.test(text[space] ?? "")) break;
      const attributeEnd = runEnd(text, space, /[A-Za-z0-9_.:-]/u);
      const equals = tagSpace(text, attributeEnd);
      at = attributeEnd;
      if (text[equals] !== "=") continue;
      const value = tagSpace(text, equals + 1);
      const quote = text[value];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, value + 1);
        if (end < 0) return undefined;
        at = end + 1;
      } else {
        at = runEnd(text, value, /[^ \t\r\n"'=<>`]/u);
        if (at === value) return undefined;
      }
    }
  at = tagSpace(text, at);
  if (!closing && text[at] === "/") at++;
  return text[at] === ">" ? { end: at + 1, name } : undefined;
}

/**
 * The text with raw HTML removed, scanning left to right: a comment (`<!--`
 * to the next `-->`), a declaration (`<!` and a letter to the next `>`), a
 * processing instruction (`<?` to the next `?>`) and any open or closing tag
 * (`rawTag`); a `script` or `style` element is removed with its contents up
 * to its closing tag when there is one. Anything else stays text: an
 * unclosed comment, `v1 <- Beta 2`, `Windows < 10 Beta 3`, `<Beta 3>`. A
 * line-breaking element (`lineBreakingElements`) becomes `blockBreak`,
 * anything else removed a space. Linear in the text: every search for a
 * closing sequence is remembered, so no stretch is searched twice for it.
 */
function withoutMarkup(text: string, blockBreak: string): string {
  const found = new Map<string, number>();
  // The next index of `pattern` at or after `from`, remembered: -1 once
  // there is none.
  const next = (key: string, pattern: RegExp, from: number) => {
    const known = found.get(key);
    if (known !== undefined && (known < 0 || known >= from)) return known;
    pattern.lastIndex = from;
    const index = pattern.exec(text)?.index ?? -1;
    found.set(key, index);
    return index;
  };
  let result = "";
  let at = 0;
  for (let open = text.indexOf("<"); open >= 0; open = text.indexOf("<", open + 1)) {
    if (open < at) continue;
    let end = -1;
    let replacement = " ";
    if (text.startsWith("<!--", open)) {
      const close = next("comment", /-->/gu, open + 4);
      if (close >= 0) end = close + 3;
    } else if (text[open + 1] === "!" && /[A-Za-z]/u.test(text[open + 2] ?? "")) {
      const close = next("declaration", />/gu, open + 2);
      if (close >= 0) end = close + 1;
    } else if (text[open + 1] === "?") {
      const close = next("instruction", /\?>/gu, open + 2);
      if (close >= 0) end = close + 2;
    } else {
      const tag = rawTag(text, open);
      if (tag !== undefined) {
        end = tag.end;
        if (lineBreakingElements.has(tag.name)) replacement = blockBreak;
        const raw = rawTextElements.find((name) => name === tag.name);
        if (raw !== undefined && text[open + 1] !== "/") {
          const letters = raw.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`);
          const close = next(
            raw,
            new RegExp(`<\\/${letters}[ \\t]*(?:(?:\\r\\n|\\r|\\n)[ \\t]*)?>`, "gu"),
            end,
          );
          if (close >= 0) end = text.indexOf(">", close) + 1;
        }
      }
    }
    if (end < 0) continue;
    result += text.slice(at, open) + replacement;
    at = end;
  }
  return result + text.slice(at);
}

/**
 * The body with raw HTML removed (`withoutMarkup`), a line-breaking element
 * becoming a line break.
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
 * image references (`![alt](beta.png)`), raw HTML (`withoutMarkup`), link targets (the link text stays), URLs, compare ranges
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
