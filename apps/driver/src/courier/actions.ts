import { enqueueAndWait } from "@/sync/engine";
import { courierScope } from "@/sync/queue";
import { deliveryPath } from "./api";

export async function recordDeliveryStep(staffId: string, id: string, action: string, body: Record<string, unknown> = {}) {
  const event = await enqueueAndWait({
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
