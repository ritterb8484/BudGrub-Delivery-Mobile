import type { StaffMe } from "@/api/types";
import { localIsoDate } from "@/id/validator";

export interface Eligibility {
  cannabis: boolean;
  courier: boolean;
  problems: string[];
}

export function eligibility(me: StaffMe | null, today: Date = new Date()): Eligibility {
  if (!me || me.active === false || (me.status && me.status !== "active")) {
    return { cannabis: false, courier: false, problems: [] };
  }
  // Older API and mock responses derive delivery access from the staff role.
  const access = me.deliveryAccess === undefined
    ? me.role === "driver" ? "cannabis" : me.role === "courier" ? "food" : null
    : me.deliveryAccess;
  const courier = (me.role === "driver" || me.role === "courier") && (access === "food" || access === "both");
  if (me.role !== "driver" || (access !== "cannabis" && access !== "both")) {
    return { cannabis: false, courier, problems: [] };
  }
  const problems: string[] = [];
  const agent = me.agent;
  if (!agent) problems.push("No agent card record on file");
  else {
    if (!agent.agentCardNumber) problems.push("Agent card number missing");
    if (!agent.agentCardExpires) problems.push("Agent card expiry missing");
    else if (agent.agentCardExpires.slice(0, 10) < localIsoDate(today)) problems.push(`Agent card expired ${agent.agentCardExpires.slice(0, 10)}`);
    if (agent.disclosedToCcb === false) problems.push("Agent card not disclosed to the CCB");
    if (agent.status && agent.status !== "active") problems.push("Agent record is not active");
    for (const problem of agent.problems ?? []) if (!problems.includes(problem)) problems.push(problem);
  }
  return { cannabis: problems.length === 0 || me.activeDeliveryMode === "cannabis", courier, problems };
}
