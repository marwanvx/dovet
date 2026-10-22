// Loops over the writers outside the event log until its parent kills it (test/adversarial/kill9.test.ts).
import { DailyLedger } from "../../../src/agent/budgets/ledger.ts";
import { createBlobStore } from "../../../src/store/blobs/store.ts";
import { writeFileAtomic } from "../../../src/store/config/atomic.ts";
import { settingsText } from "./content.ts";

const root = process.argv[2] ?? "";
const blobs = createBlobStore(`${root}/data`);
const ledger = new DailyLedger({ dir: `${root}/data/budget`, session: "S1", now: Date.now });
process.stdout.write("READY\n");
for (let i = 0; ; i++) {
  await writeFileAtomic(`${root}/settings.json`, settingsText(i % 2));
  blobs.putSync(new TextEncoder().encode(`blob ${i} ${"y".repeat(100_000)}`));
  const request = `r${i}`;
  await ledger.reserve(request, 0.01, null);
  await ledger.commit(request, 0.008);
}
