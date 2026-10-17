import { homedir } from "node:os";
import path from "node:path";

// Same-user identity is independent of checkout, pins and writable cache settings.
export function resourceDomainRoot() {
  return path.join(homedir(), ".portcove", "resources");
}
