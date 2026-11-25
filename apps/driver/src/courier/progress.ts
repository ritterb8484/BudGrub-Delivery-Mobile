import type { DeliveryStatus } from "./types";

/** Physical pickup needs a server-verified code. Travel and arrival can be recorded offline after that. */
export function queuedCourierProgress(status: DeliveryStatus, pendingActions: readonly string[]): DeliveryStatus {
  const onWay = status === "picked_up" && pendingActions.includes("en-route") ? "en_route" : status;
  return onWay === "en_route" && pendingActions.includes("arrive") ? "arrived" : onWay;
}
