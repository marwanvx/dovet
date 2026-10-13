// Real processes: spawn in a group of their own and kill the whole tree (platforms "Process-tree kill").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlatformCore, type PlatformCore } from "../../../src/platform/index.ts";
import type { AbsPath } from "../../../src/schema/index.ts";
import { type TempProject, tempProject } from "../../helpers/index.ts";

const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const env = Object.fromEntries(Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));

let project: TempProject;
let platform: PlatformCore;
let treeScript: string;
let stubbornScript: string;

beforeAll(async () => {
  project = await tempProject();
  platform = createPlatformCore({
    os,
    arch: process.arch,
    execPath: process.execPath,
    env,
    projectRoot: project.root as AbsPath,
    kill: (pid, signal) => process.kill(pid, signal),
    termGraceMs: 300,
  });
  treeScript = join(project.root, "tree.ts");
  await writeFile(
    treeScript,
    `const kid = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
console.log(JSON.stringify({ parent: process.pid, child: kid.pid }));
setInterval(() => {}, 1000);
`,
  );
  stubbornScript = join(project.root, "stubborn.ts");
  await writeFile(
    stubbornScript,
    `process.on("SIGTERM", () => {});
console.log("ready");
setInterval(() => {}, 1000);
`,
  );
});

afterAll(async () => {
  await project.dispose();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
  if (process.platform !== "linux") return true;
  // A reaper-less container leaves orphans as zombies: gone for our purposes.
  return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) text += new TextDecoder().decode(value);
    if (text.includes("\n") || done) break;
  }
  reader.releaseLock();
  return text.split("\n")[0] ?? "";
}

function run(argv: string[], group: string, extra: { stdin?: "null" | string; signal?: AbortSignal } = {}) {
  return platform.spawn({
    argv,
    cwd: project.root as AbsPath,
    env,
    signal: extra.signal ?? new AbortController().signal,
    group,
    ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
  });
}

describe("process groups", () => {
  // spec: AC-PLAT-02
  test("killTree ends the process and everything it started", async () => {
    const handle = run([process.execPath, treeScript], "tree");
    const { parent, child } = JSON.parse(await firstLine(handle.stdout)) as { parent: number; child: number };
    expect(isAlive(parent)).toBe(true);
    expect(isAlive(child)).toBe(true);

    await platform.killTree("tree");

    expect(await waitDead(parent)).toBe(true);
    expect(await waitDead(child)).toBe(true);
    await handle.exited;
  });

  // spec: AC-PLAT-02
  test("a process that ignores SIGTERM is killed after the grace period", async () => {
    const handle = run([process.execPath, stubbornScript], "stubborn");
    expect(await firstLine(handle.stdout)).toBe("ready");

    await platform.killTree("stubborn");

    expect(await waitDead(handle.pid)).toBe(true);
    await handle.exited;
  });

  // spec: AC-PLAT-02
  test("aborting the signal kills the tree", async () => {
    const abort = new AbortController();
    const handle = run([process.execPath, treeScript], "aborted", { signal: abort.signal });
    const { parent, child } = JSON.parse(await firstLine(handle.stdout)) as { parent: number; child: number };

    abort.abort();

    await handle.exited;
    expect(await waitDead(parent)).toBe(true);
    expect(await waitDead(child)).toBe(true);
  });

  test("killTree touches only its own group", async () => {
    const a = run([process.execPath, stubbornScript], "group-a");
    const b = run([process.execPath, stubbornScript], "group-b");
    await firstLine(a.stdout);
    await firstLine(b.stdout);

    await platform.killTree("group-a");
    expect(await waitDead(a.pid)).toBe(true);
    expect(isAlive(b.pid)).toBe(true);

    await platform.killTree("group-b");
    expect(await waitDead(b.pid)).toBe(true);
  });

  test("killTree on an unknown or finished group is a no-op", async () => {
    await platform.killTree("never-used");
    const done = run([process.execPath, "-e", "0"], "done");
    expect(await done.exited).toBe(0);
    await platform.killTree("done");
  });
});

describe("spawn", () => {
  test("runs in the given cwd with exactly the given environment, and reports the exit code", async () => {
    const probe = platform.spawn({
      argv: [process.execPath, "-e", "console.log(process.cwd() + '|' + process.env.DOVET_PROBE)"],
      cwd: project.root as AbsPath,
      env: { ...env, DOVET_PROBE: "yes" },
      signal: new AbortController().signal,
      group: "env",
    });
    const [cwd, value] = (await new Response(probe.stdout).text()).trim().split("|");
    expect(value).toBe("yes");
    expect(cwd?.toLowerCase()).toBe(project.root.toLowerCase());
  });

  test("reports the exit code", async () => {
    expect(await run([process.execPath, "-e", "process.exit(7)"], "exit-code").exited).toBe(7);
  });

  test('a stdin string reaches the child; "null" gives it end-of-file at once', async () => {
    const read = [process.execPath, "-e", "console.log(JSON.stringify(await Bun.stdin.text()))"];
    const fed = run(read, "stdin", { stdin: "hello" });
    expect((await new Response(fed.stdout).text()).trim()).toBe('"hello"');
    const empty = run(read, "stdin", { stdin: "null" });
    expect((await new Response(empty.stdout).text()).trim()).toBe('""');
  });

  test("stderr is a separate stream", async () => {
    const handle = run([process.execPath, "-e", "console.error('oops')"], "stderr");
    expect((await new Response(handle.stderr).text()).trim()).toBe("oops");
    expect((await new Response(handle.stdout).text()).trim()).toBe("");
  });

  test.if(os === "win32")("children get NoDefaultCurrentDirectoryInExePath=1 whatever the caller passed", async () => {
    const handle = platform.spawn({
      argv: [process.execPath, "-e", "console.log(process.env.NoDefaultCurrentDirectoryInExePath)"],
      cwd: project.root as AbsPath,
      env: { ...env, nodefaultcurrentdirectoryinexepath: "0" },
      signal: new AbortController().signal,
      group: "nodefault",
    });
    expect((await new Response(handle.stdout).text()).trim()).toBe("1");
  });

  test("a program that is not an absolute path is refused, so the OS never searches the cwd for it", () => {
    expect(() => run(["git", "--version"], "relative")).toThrow(/absolute/);
  });

  test("an already aborted signal spawns nothing", () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => run([process.execPath, "-e", "0"], "pre-aborted", { signal: abort.signal })).toThrow();
  });
});

describe("libexec", () => {
  test("helpers are found next to the real executable", () => {
    expect(platform.libexec("rg")).toBe(join(process.execPath, "..", "libexec", os === "win32" ? "rg.exe" : "rg"));
    expect(platform.libexec("srt")).toBe(join(process.execPath, "..", "libexec", "srt"));
    expect(platform.os).toBe(os);
  });
});
