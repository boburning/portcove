export function renderBoundedSummary(
  title,
  entries,
  { reference = null, maximumBytes = 16 * 1024 } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256)
    throw new RangeError("Summary limit must be at least 256 bytes");
  const lines = [];
  let bytes = 0;
  const append = (line) => {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maximumBytes - 200) return false;
    lines.push(line);
    bytes += size;
    return true;
  };
  append(String(title).slice(0, 128));
  if (reference) append(`Raw evidence: ${reference}`);
  let included = 0;
  for (const entry of entries) {
    if (!append(String(entry))) break;
    included++;
  }
  const omitted = entries.length - included;
  lines.push(`Findings: ${entries.length}; shown: ${included}; omitted: ${omitted}`);
  return { text: lines.join("\n"), total: entries.length, omitted };
}
