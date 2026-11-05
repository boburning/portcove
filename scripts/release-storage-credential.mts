/** Transport locator validation only. The caller must first establish the
 * original fixed source/job/phase. A token or these public IDs grant no job,
 * semantic, signing, protection or checkpoint authority. */
export function requireStorageAppToken(
  expected: { app_id: number; installation_id: number },
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  const token = environment.PORTCOVE_STORAGE_APP_TOKEN;
  if (
    !Number.isSafeInteger(expected.app_id) ||
    expected.app_id < 1 ||
    expected.app_id === 15368 ||
    !Number.isSafeInteger(expected.installation_id) ||
    expected.installation_id < 1 ||
    environment.PORTCOVE_STORAGE_APP_ID !== String(expected.app_id) ||
    environment.PORTCOVE_STORAGE_INSTALLATION_ID !== String(expected.installation_id) ||
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 16384 ||
    Array.from(token).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) ||
    token === environment.GH_TOKEN ||
    token === environment.PORTCOVE_COORDINATOR_JOURNAL_TOKEN ||
    token === environment.PORTCOVE_CONTROL_APP_TOKEN
  )
    throw new Error("appointed isolated storage App/installation credential unavailable");
  return token;
}
