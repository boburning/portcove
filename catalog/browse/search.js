// Progressive enhancement. Static links stay available if this optional index
// cannot be loaded. Only this origin's generated index is requested.
                         
               
                      
                    
 
                       
                
                            
 
function record(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringArray(value         )                    {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function searchIndex(value         , count        )                         {
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.length <= 10000 &&
    value.every(
      (entry         ) =>
        record(entry) &&
        typeof entry.title === "string" &&
        Array.isArray(entry.projects) &&
        entry.projects.every(
          (project         ) =>
            record(project) &&
            typeof project.name === "string" &&
            stringArray(project.platforms) &&
            stringArray(project.methods),
        ),
    )
  );
}
function element                   (selector        )    {
  const result = globalThis.document.querySelector   (selector);
  if (!result) throw new Error("Catalog search markup differs");
  return result;
}
const form = element                 ("#filters");
const query = element                  ("#query");
const platform = element                   ("#platform");
const method = element                   ("#method");
const status = element             ("#result-status");
const items = [...globalThis.document.querySelectorAll               ("#results > li")];
let index                           ;
let announcement                    ;
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
  const chunks               = [];
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
  const parsed          = JSON.parse(
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
  element             ("#search-error").hidden = false;
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
