// SPIKE-42 first look (M0-08, docs/plan/open-questions.md): does `@microsoft/mxc-sdk` load and run a command from a
// Bun-compiled executable? Throwaway: run-spike.ts runs this file with `bun`, compiles it, and runs the result; it
// prints what each step did as one JSON line. Arguments: <allowed directory> <directory outside it>.
//
// The SDK is not one of Dovet's dependencies yet; the mxc-spike workflow installs it with `bun add --no-save`. The
// import below must stay a literal string so `bun build --compile` bundles the SDK into the executable.
import { existsSync } from "node:fs";
import { join } from "node:path";

type ExecutionResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; warnings: string[] };
type ContainerRequest = {
  command: string;
  timeoutMs?: number;
  filesystem?: { readwritePaths?: string[]; readonlyPaths?: string[] };
  network?: { egress?: { default: "allow" | "deny" } };
};
// The part of `@microsoft/mxc-sdk/v1` (1.0.0, dist/v1/index.d.ts) this probe calls.
type MxcSdk = {
  getPlatformSupport(): unknown;
  getAvailableBackends(): unknown;
  run(request: ContainerRequest): Promise<ExecutionResult>;
};
type Step = { ok: true; value: unknown } | { ok: false; error: unknown };

const [allowed, outside] = Bun.argv.slice(2);
if (!allowed || !outside) throw new Error("usage: mxc-probe <allowed dir> <outside dir>");

// Assisted mode (run-spike.ts sets it): koffi, the SDK's FFI addon, looks for koffi.node next to its own JS file,
// which a compiled executable doesn't have on disk; besides that it only looks under `process.resourcesPath`
// (Electron's). Pointing that at the folder beside the executable is the smallest change that lets it load.
const resources = process.env.DOVET_MXC_RESOURCES;
if (resources) Object.defineProperty(process, "resourcesPath", { value: resources });

function describe(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  // MxcError carries code, operation, nativeStatus and remediation as own properties.
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
  // @ts-expect-error -- installed only by the mxc-spike workflow; the shape used here is typed by MxcSdk above.
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
  report.insideExists = existsSync(inside);
  report.outsideExists = existsSync(outsideFile);
  report.networkDenied = await step(() =>
    mxc.run({
      command: "curl.exe -sS -m 10 -o NUL -w %{http_code} https://example.com",
      network: { egress: { default: "deny" } },
      timeoutMs: 60_000,
    }),
  );
}
process.stdout.write(`${JSON.stringify(report)}\n`);
