// SPIKE-42 probe (M0-08), run by run-spike.ts. Args: <allowed dir> <outside dir>.
import { existsSync } from "node:fs";
import { join } from "node:path";

type ExecutionResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; warnings: string[] };
type ContainerRequest = {
  command: string;
  timeoutMs?: number;
  filesystem?: { readwritePaths?: string[]; readonlyPaths?: string[] };
  network?: { egress?: { default: "allow" | "deny" } };
};
type MxcSdk = {
  getPlatformSupport(): unknown;
  getAvailableBackends(): unknown;
  run(request: ContainerRequest): Promise<ExecutionResult>;
};
type Step = { ok: true; value: unknown } | { ok: false; error: unknown };

const [allowed, outside] = Bun.argv.slice(2);
if (!allowed || !outside) throw new Error("usage: mxc-probe <allowed dir> <outside dir>");

// koffi finds koffi.node only beside its own JS (absent when compiled) or under Electron's process.resourcesPath.
const resources = process.env.DOVET_MXC_RESOURCES;
if (resources) Object.defineProperty(process, "resourcesPath", { value: resources });

function describe(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message, ...Object.fromEntries(Object.entries(error)) };
}

async function step(run: () => unknown): Promise<Step> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

const report: Record<string, unknown> = { exe: process.execPath, assisted: Boolean(resources) };
let sdk: MxcSdk | undefined;
report.import = await step(async () => {
  // @ts-expect-error -- installed only by the mxc-spike workflow; must stay a literal so --compile bundles it.
  sdk = await import("@microsoft/mxc-sdk/v1");
  return "loaded";
});
if (sdk) {
  const mxc = sdk;
  report.platformSupport = await step(() => mxc.getPlatformSupport());
  report.availableBackends = await step(() => mxc.getAvailableBackends());
  report.echo = await step(() => mxc.run({ command: "cmd /c echo hi", timeoutMs: 60_000 }));
  const inside = join(allowed, "inside.txt");
  const outsideFile = join(outside, "outside.txt");
  report.writeInside = await step(() =>
    mxc.run({
      command: `cmd /c echo ok > "${inside}"`,
      filesystem: { readwritePaths: [allowed] },
      timeoutMs: 60_000,
    }),
  );
  report.writeOutside = await step(() =>
    mxc.run({
      command: `cmd /c echo no > "${outsideFile}"`,
      filesystem: { readwritePaths: [allowed] },
      timeoutMs: 60_000,
    }),
  );
  const noRoot = join(allowed, "no-root.txt");
  report.writeWithoutRoot = await step(() => mxc.run({ command: `cmd /c echo no > "${noRoot}"`, timeoutMs: 60_000 }));
  report.noRootExists = existsSync(noRoot);
  report.insideExists = existsSync(inside);
  report.outsideExists = existsSync(outsideFile);
  report.networkDenied = await step(() =>
    mxc.run({
      command: "curl.exe -sS -m 10 -o NUL -w %{http_code} https://example.com",
      network: { egress: { default: "deny" } },
      timeoutMs: 60_000,
    }),
  );
  report.networkAllowed = await step(() =>
    mxc.run({
      command: "curl.exe -sS -m 10 -o NUL -w %{http_code} https://example.com",
      network: { egress: { default: "allow" } },
      timeoutMs: 60_000,
    }),
  );
}
process.stdout.write(`${JSON.stringify(report)}\n`);
