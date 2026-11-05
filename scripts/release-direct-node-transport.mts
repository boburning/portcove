/** Preserve direct TLS and proxy trust at migrated isolated release boundaries. */
export function assertTrustedDirectNode(scope: string) {
  const nodeOptions = [process.env.NODE_OPTIONS ?? "", ...process.execArgv].join(" ");
  if (
    process.env.NODE_USE_ENV_PROXY === "1" ||
    /(?:^|[\s"'])--use-(?:env-proxy|openssl-ca|system-ca)(?:=|[\s"']|$)/u.test(nodeOptions) ||
    process.env.NODE_USE_SYSTEM_CA === "1" ||
    process.env.SSL_CERT_FILE ||
    process.env.SSL_CERT_DIR ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    process.env.NODE_EXTRA_CA_CERTS
  )
    throw new Error(`${scope} requires the trusted direct Node runtime`);
}
