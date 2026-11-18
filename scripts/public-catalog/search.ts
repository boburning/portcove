// Progressive enhancement. Static links stay available if this optional index
// cannot be loaded. Only this origin's generated index is requested.
interface SearchProject {
  name: string;
  platforms: string[];
  methods: string[];
}
interface SearchEntry {
  title: string;
  projects: SearchProject[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function searchIndex(value: unknown, count: number): value is SearchEntry[] {
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.length <= 10000 &&
    value.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry.title === "string" &&
        Array.isArray(entry.projects) &&
        entry.projects.every(
          (project: unknown) =>
            record(project) &&
            typeof project.name === "string" &&
            stringArray(project.platforms) &&
            stringArray(project.methods),
        ),
    )
  );
}
function element<T extends Element>(selector: string): T {
  const result = globalThis.document.querySelector<T>(selector);
  if (!result) throw new Error("Catalog search markup differs");
  return result;
}
const form = element<HTMLFormElement>("#filters");
const query = element<HTMLInputElement>("#query");
const platform = element<HTMLSelectElement>("#platform");
const method = element<HTMLSelectElement>("#method");
const status = element<HTMLElement>("#result-status");
const items = [...globalThis.document.querySelectorAll<HTMLLIElement>("#results > li")];
let index: SearchEntry[] | undefined;
let announcement: number | undefined;
function filter() {
  const current = index;
  if (!current) return;
  const term = query.value.trim().toLocaleLowerCase("en");
  let count = 0;
  items.forEach((item, position) => {
    const entry = current[position];
    const matches =
      !!entry &&
      entry.projects.some(
        (project) =>
          (!term || `${entry.title} ${project.name}`.toLocaleLowerCase("en").includes(term)) &&
          (!platform.value || project.platforms.includes(platform.value)) &&
          (!method.value || project.methods.includes(method.value)),
      );
    item.hidden = !matches;
    if (matches) count++;
  });
  globalThis.clearTimeout(announcement);
  announcement = globalThis.setTimeout(() => {
    status.textContent = count
      ? `${count} game groups and ungrouped projects`
      : "No matches. Try a different search or clear the filters.";
  }, 180);
}
try {
  const response = await globalThis.fetch("search-index.json", { credentials: "omit" });
  if (!response.ok || !response.body) throw new Error("Search unavailable");
  // Byte bound applies before JSON parsing, even for an unexpected response.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("Search exceeds bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(
    new globalThis.TextDecoder("utf-8", { fatal: true }).decode(buffer),
  );
  if (!searchIndex(parsed, items.length)) throw new Error("Search differs");
  index = parsed;
  form.addEventListener("input", filter);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    filter();
  });
  form.addEventListener("reset", () => globalThis.setTimeout(filter, 0));
  form.dataset.searchReady = "true";
  filter();
} catch {
  index = undefined;
  element<HTMLElement>("#search-error").hidden = false;
  for (const control of form.elements) {
    if (
      control instanceof globalThis.HTMLInputElement ||
      control instanceof globalThis.HTMLSelectElement ||
      control instanceof globalThis.HTMLButtonElement
    )
      control.disabled = true;
  }
}
export {};
