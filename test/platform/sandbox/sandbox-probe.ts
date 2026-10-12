// Built by sandbox.test.ts as the `dovet` of an install-directory archive (scripts/build-release.ts). Starts
// sandbox-runtime the way Dovet will (every helper by explicit path into libexec/srt/), runs commands in the
// sandbox, and prints what happened as JSON. Arguments: <allowed directory> <directory outside it>.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { libexecPath } from "../../../src/platform/index.ts";
import { startSandbox } from "../../../src/policy/index.ts";

const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const [allowed, outside] = Bun.argv.slice(2);
if (!allowed || !outside) throw new Error("usage: dovet <allowed dir> <outside dir>");
const exe = realpathSync(process.execPath);
const srtDir = libexecPath(exe, os, "srt");
const rgPath = libexecPath(exe, os, "rg");

const report: Record<string, unknown> = { exe, srtDir, os };
try {
  const sandbox = await startSandbox({
    os,
    srtDir,
    rgPath: existsSync(rgPath) ? rgPath : undefined,
    allowWrite: [allowed],
  });
  report.dependencies = sandbox.checkDependencies();
  report.enabled = sandbox.isSandboxingEnabled();
  const run = async (command: string) => {
    const wrapped = await sandbox.wrapWithSandbox(command);
    const r = Bun.spawnSync(["/bin/sh", "-c", wrapped], { stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  if (os !== "win32") {
    report.echo = await run("echo hi");
    report.writeAllowed = await run(`echo ok > '${join(allowed, "inside.txt")}'`);
    report.writeOutside = await run(`echo no > '${join(outside, "outside.txt")}'`);
    report.insideExists = existsSync(join(allowed, "inside.txt"));
    report.outsideExists = existsSync(join(outside, "outside.txt"));
  }
  await sandbox.reset();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}
process.stdout.write(`${JSON.stringify(report)}\n`);
