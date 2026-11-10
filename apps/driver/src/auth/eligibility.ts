import type { StaffMe } from "@/api/types";
import { localIsoDate } from "@/id/validator";

/**
 * Which modes this staff member may use (BUD-67, NAC 678B.327). Cannabis mode requires role `driver` and an active
 * sales-facility agent record: card on file, unexpired, disclosed to the CCB, not suspended. The API enforces this too
 * (services/staff.ts suspends ineligible drivers and GET /admin/me reflects it); the app just hides the mode.
 */
export interface Eligibility {
  cannabis: boolean;
  courier: boolean;
  problems: string[];
}

export function eligibility(me: StaffMe | null, today: Date = new Date()): Eligibility {
  if (!me) return { cannabis: false, courier: false, problems: ["Not signed in"] };
  const problems: string[] = [];
  if (me.role !== "driver") problems.push("Your account is not a driver account");
  if (me.status && me.status !== "active") problems.push("Your account is suspended");
  const a = me.agent;
  if (!a) problems.push("No agent card record on file");
  else {
    if (!a.agentCardNumber) problems.push("Agent card number missing");
    if (!a.agentCardExpires) problems.push("Agent card expiry missing");
    // Local calendar day: in UTC a Nevada evening is already "tomorrow", which expired cards on their last valid day.
    else if (a.agentCardExpires.slice(0, 10) < localIsoDate(today)) problems.push(`Agent card expired ${a.agentCardExpires.slice(0, 10)}`);
    if (a.disclosedToCcb === false) problems.push("Agent card not disclosed to the CCB");
    if (a.status && a.status !== "active") problems.push("Agent record is not active");
    for (const p of a.problems ?? []) if (!problems.includes(p)) problems.push(p);
  }
  const isActiveDriver = me.role === "driver" && (!me.status || me.status === "active");
  return { cannabis: problems.length === 0, courier: isActiveDriver, problems };
}
