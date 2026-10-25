export function validateGitHubBody(body: unknown) {
  if (typeof body !== "string" || !body.trim())
    throw new Error("GitHub body must be nonempty text");
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    const invalid =
      code === 13
        ? body.charCodeAt(index + 1) !== 10
        : code === 127 || (code < 32 && code !== 9 && code !== 10);
    if (invalid) throw new Error(`Unexpected control character at text offset ${index}`);
  }
  // JSON/string input also must not contain malformed Unicode surrogate pairs.
  if (!body.isWellFormed()) throw new Error("GitHub body contains malformed Unicode");
  return body;
}
