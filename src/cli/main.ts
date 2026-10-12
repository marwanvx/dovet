// Dovet's entry point and composition root: the only file that touches `process.*` (architecture "Modules").
import { realpathSync } from "node:fs";
import pkg from "../../package.json";
import { RELEASE_PUBLIC_KEYS } from "./release-signature.ts";
import { detectMusl, hostTargetId, installRootFor, LATEST_RELEASE_URL, rollback, update } from "./update.ts";

// Set by `define` in a pull request's test release only; a normal build has no such identifier (architecture "Distribution").
declare const DOVET_TEST_UPDATE: { publicKey: string; baseUrl: string } | undefined;
const testUpdate = typeof DOVET_TEST_UPDATE === "undefined" ? undefined : DOVET_TEST_UPDATE;

async function runUpdate(rollingBack: boolean): Promise<void> {
  const root = installRootFor(realpathSync(process.execPath));
  const os = process.platform;
  if (rollingBack) {
    const { from, to } = rollback({ root, os });
    console.log(`Rolled back dovet ${from} to ${to}.`);
    return;
  }
  const result = await update({
    root,
    baseUrl: testUpdate?.baseUrl ?? LATEST_RELEASE_URL,
    targetId: hostTargetId(os, process.arch, detectMusl()),
    os,
    publicKeys: testUpdate ? [testUpdate.publicKey] : RELEASE_PUBLIC_KEYS,
  });
  if (result.status === "current") console.log(`dovet ${result.version} is up to date.`);
  else console.log(`Updated dovet ${result.from} to ${result.to}. The next dovet you start is the new one.`);
  if (result.status === "updated")
    for (const e of result.pruneErrors) console.error(`dovet: could not remove an old version: ${e}`);
}

const args = process.argv.slice(2);
if (args[0] === "update" && (args.length === 1 || (args.length === 2 && args[1] === "--rollback"))) {
  try {
    await runUpdate(args.length === 2);
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (args[0] === "update") {
  console.error("usage: dovet update [--rollback]");
  process.exitCode = 2;
} else {
  process.stdout.write(`dovet ${pkg.version}\n`);
}
