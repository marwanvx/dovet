// M2-16: the Windows sandbox escape suite against MXC, the no-setup backend (permissions §7.6). A record: every case
// prints whether the command got out; the runner decides nothing except that the controls must work.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Result = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
type Request = {
  command: string;
  timeoutMs?: number;
  filesystem?: { readwritePaths?: string[]; readonlyPaths?: string[]; deniedPaths?: string[] };
  network?: { egress?: { default: "allow" | "deny" } };
};
type Sdk = { getPlatformSupport(): unknown; getAvailableBackends(): unknown; run(r: Request): Promise<Result> };

if (process.platform !== "win32") throw new Error("the escape suite runs on a Windows runner");
// @ts-expect-error -- installed only by the workflow (bun add --no-save).
const sdk = (await import("@microsoft/mxc-sdk/v1")) as Sdk;

const base = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "dovet-escape-")));
const allowed = join(base, "allowed");
const outside = join(base, "outside");
const cred = join(base, "cred");
for (const d of [allowed, outside, cred]) mkdirSync(d);
writeFileSync(join(cred, "secret.txt"), "TOPSECRET-9f3a");
writeFileSync(join(outside, "readable.txt"), "OUTSIDE-READ-7c1d");
const fs = { readwritePaths: [allowed] };

type Row = { name: string; kind: "control" | "escape"; ok: boolean; detail: string };
const rows: Row[] = [];
async function run(request: Request): Promise<Result | { error: string }> {
  try {
    return await sdk.run({ timeoutMs: 60_000, ...request });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
const short = (r: Result | { error: string }): string =>
  "error" in r
    ? `error: ${r.error}`
    : `exit ${r.exitCode}${r.timedOut ? " timed out" : ""} ${r.stdout.trim().slice(0, 120)} ${r.stderr.trim().slice(0, 120)}`;
/** `ok` is true when the sandbox held (an escape did not happen, a control worked). */
function record(name: string, kind: Row["kind"], ok: boolean, r: Result | { error: string }): void {
  rows.push({ name, kind, ok, detail: short(r) });
}

const hostWrites = async (name: string, target: string, command: string, filesystem = fs): Promise<void> => {
  const r = await run({ command, filesystem });
  record(name, "escape", !existsSync(target), r);
};

const inside = join(allowed, "inside.txt");
const wrote = await run({ command: `cmd /c echo ok > "${inside}"`, filesystem: fs });
record("write inside the allowed root", "control", existsSync(inside), wrote);

await hostWrites(
  "write outside the root",
  join(outside, "plain.txt"),
  `cmd /c echo x > "${join(outside, "plain.txt")}"`,
);
await hostWrites(
  "write outside through ..",
  join(outside, "dotdot.txt"),
  `cmd /c echo x > "${allowed}\\..\\outside\\dotdot.txt"`,
);
await hostWrites(
  "write outside with a \\\\?\\ path",
  join(outside, "verbatim.txt"),
  `cmd /c echo x > "\\\\?\\${outside}\\verbatim.txt"`,
);
await hostWrites(
  "write outside through the C$ admin share",
  join(outside, "share.txt"),
  `cmd /c echo x > "\\\\localhost\\${outside[0]}$${outside.slice(2)}\\share.txt"`,
);
await hostWrites(
  "write outside from a child PowerShell",
  join(outside, "child.txt"),
  `powershell -NoProfile -Command "Set-Content -Path '${join(outside, "child.txt")}' -Value x"`,
);
await hostWrites(
  "write outside from a grandchild cmd",
  join(outside, "grand.txt"),
  `cmd /c cmd /c cmd /c echo x ^> "${join(outside, "grand.txt")}"`,
);

symlinkSync(outside, join(allowed, "junction"), "junction");
await hostWrites(
  "write outside through a junction planted in the root",
  join(outside, "junction.txt"),
  `cmd /c echo x > "${join(allowed, "junction", "junction.txt")}"`,
);
try {
  symlinkSync(join(cred, "secret.txt"), join(allowed, "linked-secret.txt"), "file");
} catch {
  writeFileSync(join(allowed, "linked-secret.txt"), "no symlink privilege");
}

const readSecret = await run({
  command: `cmd /c type "${join(cred, "secret.txt")}"`,
  filesystem: { ...fs, deniedPaths: [cred] },
});
record(
  "read a denied credential file",
  "escape",
  !("stdout" in readSecret && readSecret.stdout.includes("TOPSECRET")),
  readSecret,
);
const readViaLink = await run({
  command: `cmd /c type "${join(allowed, "linked-secret.txt")}"`,
  filesystem: { ...fs, deniedPaths: [cred] },
});
record(
  "read a denied credential file through a link in the root",
  "escape",
  !("stdout" in readViaLink && readViaLink.stdout.includes("TOPSECRET")),
  readViaLink,
);
const readOutside = await run({ command: `cmd /c type "${join(outside, "readable.txt")}"`, filesystem: fs });
record(
  "read an ordinary file outside the root (allowed by design)",
  "control",
  "stdout" in readOutside && readOutside.stdout.includes("OUTSIDE-READ"),
  readOutside,
);

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("HOST-SERVICE-REACHED") });
const curl = (url: string): string => `curl.exe -sS -m 10 ${url}`;
for (const [name, url] of [
  ["reach a service on the host's loopback", `http://127.0.0.1:${server.port}/`],
  ["reach the internet by name", "https://example.com/"],
  ["reach the internet by address", "https://1.1.1.1/"],
] as const) {
  const r = await run({ command: curl(url), filesystem: fs, network: { egress: { default: "deny" } } });
  record(name, "escape", !("stdout" in r && r.stdout.length > 0 && r.exitCode === 0), r);
}
server.stop(true);
const open = await run({
  command: curl("https://example.com/"),
  filesystem: fs,
  network: { egress: { default: "allow" } },
});
record(
  "control: egress allowed reaches example.com",
  "control",
  "stdout" in open && open.exitCode === 0 && open.stdout.length > 0,
  open,
);

process.env.DOVET_ESCAPE_SECRET = "ENV-SECRET-4b2e";
const env = await run({ command: "cmd /c echo %DOVET_ESCAPE_SECRET%", filesystem: fs });
record(
  "see a secret from the host's environment",
  "escape",
  !("stdout" in env && env.stdout.includes("ENV-SECRET")),
  env,
);

const version = Bun.spawnSync([
  "reg",
  "query",
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
  "/v",
  "ProductName",
])
  .stdout.toString()
  .trim()
  .split("\n")
  .at(-1)
  ?.trim();
const header = {
  windows: version,
  arch: process.arch,
  platformSupport: JSON.stringify(sdk.getPlatformSupport()),
  backends: JSON.stringify(sdk.getAvailableBackends()),
};
const table = rows
  .map(
    (r) =>
      `| ${r.kind} | ${r.name} | ${r.ok ? (r.kind === "control" ? "works" : "held") : r.kind === "control" ? "BROKEN" : "ESCAPED"} | ${r.detail.replaceAll("|", "/").replaceAll("\n", " ")} |`,
  )
  .join("\n");
const text = `${JSON.stringify(header)}\n\n| kind | case | result | detail |\n|---|---|---|---|\n${table}\n`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Windows escape suite (${process.arch})\n\n${text}`);
const brokenControls = rows.filter((r) => r.kind === "control" && !r.ok && !r.name.includes("egress allowed"));
if (brokenControls.length > 0) throw new Error(`controls failed: ${brokenControls.map((r) => r.name).join(", ")}`);
