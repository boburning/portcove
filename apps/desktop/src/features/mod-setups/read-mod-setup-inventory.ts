import { desktopApi } from "../../api";
import { CoalescedRequest } from "../../shared/concurrency-state";
import type { ModSetupsView } from "../../types";

type InventoryRead = {
  requests: CoalescedRequest;
  pending: number;
  view?: ModSetupsView;
};

// Keep ownership until native work settles, including across component remounts.
// Settled views are never cached: every later request reads current Core state.
const reads = new Map<string, InventoryRead>();

export async function readModSetupInventory(portId: string, generation: number) {
  const key = JSON.stringify([portId, generation]);
  let read = reads.get(key);
  if (!read) {
    read = { requests: new CoalescedRequest(), pending: 0 };
    reads.set(key, read);
  }
  const owner = read;
  owner.pending += 1;
  try {
    await owner.requests.request(async () => {
      owner.view = await desktopApi.modSetups(portId, generation);
    });
    return owner.view!;
  } finally {
    owner.pending -= 1;
    if (owner.pending === 0) {
      owner.requests.close();
      reads.delete(key);
    }
  }
}
