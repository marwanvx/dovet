// Built by install-layout.test.ts as the `dovet` of an install-directory archive (scripts/build-release.ts). Finds
// the bundled ripgrep the way Dovet will (relative to its own executable) and runs it, printing what happened as JSON.
import { realpathSync } from "node:fs";
import { libexecPath } from "../../../src/platform/index.ts";

const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const exe = realpathSync(process.execPath);
const rg = libexecPath(exe, os, "rg");
const run = Bun.spawnSync([rg, "--version"], { stdout: "pipe", stderr: "pipe" });
process.stdout.write(
  `${JSON.stringify({ exe, rg, exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() })}\n`,
);
