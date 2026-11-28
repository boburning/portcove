import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export function documentText(source: string) {
  let fence = "";
  return source
    .split(/\r?\n/u)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fence) {
        if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = "";
        return "";
      }
      if (!marker) return line;
      fence = marker[1]!;
      return "";
    })
    .join("\n");
}

function readDocument(root: string, file: string) {
  const relative = path.relative(root, realpathSync(file));
  if (
    !lstatSync(file).isFile() ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(`Documentation content must be a regular repository file: ${file}`);
  return readFileSync(file, "utf8");
}

function headingIds(prose: string) {
  const ids = new Set<string>();
  for (const match of prose.matchAll(/^ {0,3}#{1,6}[ \t]+(.+)$/gmu)) {
    const base = match[1]!
      .trim()
      .replace(/\s+#+$/u, "")
      .trimEnd()
      .toLowerCase()
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
      .replace(/<[^>]+>/gu, "")
      .replace(
        /(`+)([^\n]*?)\1|(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.+?)\3(?![\p{L}\p{N}_])/gu,
        (_whole, code: string | undefined, literal: string, _emphasis: string, label: string) =>
          code ? literal : label,
      )
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
      .replace(/ /gu, "-");
    let id = base;
    for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
  }
  for (const match of prose.matchAll(/<[a-z][a-z0-9-]*\b[^>]*?\s(?:id|name)=["']([^"']+)["']/giu)) {
    ids.add(match[1]!);
  }
  return ids;
}

export function checkDocumentLinks(root: string, files: readonly string[]) {
  const canonicalRoot = realpathSync(root);
  const anchors = new Map<string, Set<string>>();
  const lineCounts = new Map<string, number>();
  for (const file of files.filter((name) => name.endsWith(".md"))) {
    const source = path.resolve(root, file);
    if (!existsSync(source)) continue;
    const prose = documentText(readDocument(canonicalRoot, source));
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = (match[1] ?? "").replace(/^<|>$/gu, "").split(/\s+"/u)[0] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      const [relative, fragment] = target.split("#", 2);
      const resolved = path.resolve(
        path.dirname(source),
        decodeURIComponent(relative?.split("?", 1)[0] || path.basename(source)),
      );
      const within = path.relative(root, resolved);
      if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
        throw new Error(`Documentation link escapes repository: ${file} -> ${target}`);
      if (!existsSync(resolved)) throw new Error(`Broken local link: ${file} -> ${target}`);
      if (!fragment) continue;
      const anchor = decodeURIComponent(fragment);
      const lines = /^L(\d+)(?:-L(\d+))?$/u.exec(anchor);
      if (lines) {
        if (!lineCounts.has(resolved)) {
          const content = readDocument(canonicalRoot, resolved);
          lineCounts.set(
            resolved,
            content.length ? content.replace(/\n$/u, "").split("\n").length : 0,
          );
        }
        const start = Number(lines[1]);
        const end = Number(lines[2] ?? lines[1]);
        if (start < 1 || end < start || end > lineCounts.get(resolved)!)
          throw new Error(`Broken source line: ${file} -> ${target}`);
      } else if (resolved.endsWith(".md")) {
        if (!anchors.has(resolved))
          anchors.set(resolved, headingIds(documentText(readDocument(canonicalRoot, resolved))));
        if (!anchors.get(resolved)!.has(anchor))
          throw new Error(`Broken local anchor: ${file} -> ${target}`);
      }
    }
  }
}
