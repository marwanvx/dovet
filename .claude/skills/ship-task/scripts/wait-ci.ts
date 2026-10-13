// Waits for every check on a PR to finish; prints each result and exits 0 only if all passed.
const pr = process.argv[2];
if (pr === undefined || !/^\d+$/.test(pr)) {
  console.error("usage: bun wait-ci.ts <pr number>");
  process.exit(64);
}

type Check = { name: string; state: string; bucket: string; link: string };

async function checks(): Promise<Check[]> {
  const proc = Bun.spawn(["gh", "pr", "checks", pr as string, "--json", "name,state,bucket,link"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // gh exits 8 while checks are pending, and 1 with "no checks reported" just after the PR opens.
  if (code === 1 && err.includes("no checks reported")) return [];
  if (code !== 0 && code !== 8) throw new Error(`gh pr checks failed (${code}): ${err.trim()}`);
  return out.trim() === "" ? [] : (JSON.parse(out) as Check[]);
}

const deadline = Date.now() + 60 * 60 * 1000;
let failures = 0;
for (;;) {
  let list: Check[];
  try {
    list = await checks();
    failures = 0;
  } catch (e) {
    // A network blip shouldn't end the wait; ten in a row is a real outage.
    if (++failures >= 10) throw e;
    console.error(`retrying: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    await Bun.sleep(30_000);
    continue;
  }
  const pending = list.filter((c) => c.bucket === "pending");
  if (list.length > 0 && pending.length === 0) {
    for (const c of list) console.log(`${c.bucket.padEnd(8)} ${c.name}  ${c.link}`);
    process.exit(list.every((c) => c.bucket === "pass" || c.bucket === "skipping") ? 0 : 1);
  }
  if (Date.now() > deadline) {
    console.error(`still pending after an hour: ${pending.map((c) => c.name).join(", ")}`);
    process.exit(2);
  }
  await Bun.sleep(30_000);
}
