import assert from "node:assert/strict";

// Ephemeral harness ownership, never durable operation or product authority.
export class OwnedNativeSession {
  driver;
  inventory;
  cleanup;

  beginLaunch() {
    // Invalidate the former host's proof before a replacement can exist,
    // including when spawn succeeds but identity capture fails.
    this.driver = undefined;
    this.inventory = undefined;
    this.cleanup = undefined;
  }

  requireQuiescence() {
    assert.ok(this.driver, "Current owned launch identity is required");
    assert.ok(this.inventory, "Current owned exit inventory is required");
    assert.ok(this.cleanup?.exited, "Positive current owned root/descendant exit is required");
    return this.cleanup;
  }
}
