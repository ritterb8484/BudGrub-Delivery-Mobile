import { createServer } from "./server.mjs";

const port = Number(process.env.PORT ?? 4000);
const { server, state } = createServer();
server.listen(port, "0.0.0.0", () => {
  console.log(`BudGrub mock API on http://localhost:${port}/api (KEYCLOAK_MODE=stub)`);
  console.log(`Driver stub identity: Jamal Pierce (stub-jamal). Trip ${state.trips[0].number} is assigned.`);
  console.log("Dispatch controls: POST /api/__mock/{reset,assign,metrc}, /api/__mock/trips/:id/{amend-plan,reissue-manifest}");
});
