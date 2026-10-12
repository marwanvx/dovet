// SPIKE-42 (M0-08): runs mxc-probe.ts under bun, compiled alone, and compiled with the SDK's native files beside it.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDovet } from "../../../scripts/build.ts";

if (process.platform !== "win32") throw new Error("SPIKE-42 is about native Windows; run this on a Windows runner");

const ROOT = join(import.meta.dir, "..", "..", "..");
const PROBE = join(import.meta.dir, "mxc-probe.ts");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const work = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "dovet-mxc-")));

function windowsVersion(): string {
  const key = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
  const values = ["ProductName", "DisplayVersion", "CurrentBuild", "UBR", "EditionID", "InstallationType"].map(
    (name) => {
      const r = Bun.spawnSync(["reg", "query", key, "/v", name]);
      const line = r.stdout
        .toString()
        .split("\n")
        .find((l) => l.includes(name));
      return line?.trim().replace(/\s+REG_\w+\s+/, "=") ?? `${name}=?`;
    },
  );
  return values.join(" ");
}

function probe(label: string, cmd: string[], env: Record<string, string> = {}): unknown {
  const dirs = join(work, `${label}-dirs`);
  const allowed = join(dirs, "allowed");
  const outside = join(dirs, "outside");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const started = performance.now();
  // cwd outside the checkout, so the compiled probe can't reach node_modules.
  const r = Bun.spawnSync([...cmd, allowed, outside], {
    cwd: dirs,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const ms = Math.round(performance.now() - started);
  const stdout = r.stdout.toString().trim();
  const stderr = r.stderr.toString().trim();
  const line = stdout.split("\n").at(-1) ?? "";
  try {
    return { label, exitCode: r.exitCode, ms, report: JSON.parse(line), stderr };
  } catch {
    return { label, exitCode: r.exitCode, ms, stdout, stderr, noReport: true };
  }
}

const results: unknown[] = [];
results.push({ windows: windowsVersion(), bun: Bun.version, arch });

results.push(probe("bun", [process.execPath, PROBE]));

const plainExe = join(work, "plain", "dovet-mxc-probe.exe");
await compileDovet({ entry: PROBE, outfile: plainExe });
results.push(probe("compiled", [plainExe]));

const assisted = join(work, "assisted");
const assistedExe = join(assisted, "dovet-mxc-probe.exe");
await compileDovet({ entry: PROBE, outfile: assistedExe });
const mxcDir = join(assisted, "libexec", "mxc");
cpSync(join(ROOT, "node_modules", "@microsoft", "mxc-sdk", "bin", arch), join(mxcDir, arch), {
  recursive: true,
  filter: (src) => !src.includes("_manifest"),
});
cpSync(
  join(ROOT, "node_modules", "@koromix", `koffi-win32-${arch}`, `win32_${arch}`),
  join(mxcDir, "koffi", `win32_${arch}`),
  { recursive: true },
);
results.push(
  probe("compiled-assisted", [assistedExe], {
    MXC_BIN_DIR: mxcDir,
    MXC_FFI_DIR: join(mxcDir, arch),
    DOVET_MXC_RESOURCES: mxcDir,
  }),
);

const text = results.map((r) => JSON.stringify(r, null, 2)).join("\n");
console.log(text);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary, `## SPIKE-42 (${arch})\n\n\`\`\`json\n${text}\n\`\`\`\n`);
const missing = results.filter((r) => typeof r === "object" && r !== null && "noReport" in r);
if (missing.length > 0) throw new Error(`${missing.length} probe(s) printed no report (see above)`);
