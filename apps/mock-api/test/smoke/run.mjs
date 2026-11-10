import { start } from "../helpers.mjs";
import { smokeDriver } from "./smoke-driver.mjs";

/** Smoke runner. Starts the mock API unless SMOKE_BASE points at a running API (e.g. http://localhost:4000/api). */
const suites = [["driver", smokeDriver]];

const srv = process.env.SMOKE_BASE ? null : await start();
const base = process.env.SMOKE_BASE ?? srv.base;
let failed = 0;
for (const [name, run] of suites) {
  console.log(`smoke:${name} → ${base}`);
  try {
    await run(base);
    console.log(`smoke:${name} passed`);
  } catch (e) {
    failed++;
    console.error(`smoke:${name} FAILED`, e);
  }
}
await srv?.close();
process.exit(failed ? 1 : 0);
