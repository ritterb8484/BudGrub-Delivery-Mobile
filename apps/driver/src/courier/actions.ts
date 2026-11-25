import { enqueue, enqueueAndWait } from "@/sync/engine";
import { courierScope } from "@/sync/queue";
import { deliveryPath } from "./api";

export async function recordDeliveryStep(staffId: string, id: string, action: string, body: Record<string, unknown> = {}, offline = false) {
  const persist = offline ? enqueue : enqueueAndWait;
  const event = await persist({
    scope: courierScope(staffId, id),
    kind: "courier_step",
    path: `${deliveryPath(id)}/${action}`,
    body,
    sequenced: false,
    meta: { action },
  });
  if (event.status === "rejected") throw new Error(event.lastError ?? "The server refused this delivery step.");
  return event.status;
}
