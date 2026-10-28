/** Fixture only: keep the caller alive after the real CLI/API settles so its
 * exit-time terminal reset cannot hide a broken restoration boundary. No
 * passphrase input is read here; the driver sends only a public final ack. */
import { ownerRecoveryMain } from "../catalog-recovery-vault-cli.mts";
await ownerRecoveryMain();
process.stdout.write("FIXTURE_API_SETTLED\n");
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => {
    process.stdin.pause();
    resolve();
  });
  process.stdin.resume();
});
