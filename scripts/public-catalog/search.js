// Progressive enhancement. Static links stay available if this optional index
// cannot be loaded. Only this origin's generated index is requested.
const form = globalThis.document.querySelector("#filters");
const query = globalThis.document.querySelector("#query");
const platform = globalThis.document.querySelector("#platform");
const method = globalThis.document.querySelector("#method");
const status = globalThis.document.querySelector("#result-status");
const items = [...globalThis.document.querySelectorAll("#results > li")];
let index;
let announcement;
function filter() {
  if (!index) return;
  const term = query.value.trim().toLocaleLowerCase("en");
  let count = 0;
  items.forEach((item, position) => {
    const entry = index[position];
    const matches = entry.projects.some(
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
  if (!response.ok) throw new Error("Search unavailable");
  // Byte bound applies before JSON parsing, even for an unexpected response.
  const reader = response.body.getReader();
  const chunks = [];
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
  index = JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(buffer));
  if (
    !Array.isArray(index) ||
    index.length !== items.length ||
    index.length > 10000 ||
    index.some(
      (entry) =>
        typeof entry.title !== "string" ||
        !Array.isArray(entry.projects) ||
        entry.projects.some(
          (project) =>
            typeof project.name !== "string" ||
            !Array.isArray(project.platforms) ||
            !Array.isArray(project.methods),
        ),
    )
  )
    throw new Error("Search differs");
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
  globalThis.document.querySelector("#search-error").hidden = false;
  for (const control of form.elements) control.disabled = true;
}
