// `bun run build`: compile `dovet` for the current OS into dist/ (architecture "Distribution").
//
//     bun run build                              # dist/dovet (dist/dovet.exe on Windows)
//     bun scripts/build.ts --tui-demo <outfile>  # the SPIKE-4 terminal demo (scripts/tui-demo.ts)
//
// compileDovet() holds the compile options; the compile-flags test and build-release.ts build with it.
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");

export async function compileDovet(opts: {
  outfile: string;
  entry?: string;
  target?: Bun.Build.CompileTarget;
}): Promise<string[]> {
  // Bun.build rejects with the build errors when compiling fails (`throw` defaults to true).
  const result = await Bun.build({
    metafile: true,
    entrypoints: [opts.entry ?? join(ROOT, "src", "cli", "main.ts")],
    compile: {
      outfile: opts.outfile,
      // Omitted: the machine running the build. `bun run release` passes each of the eight targets.
      ...(opts.target ? { target: opts.target } : {}),
      // Security-critical (architecture "Compile flags"): a compiled Bun executable otherwise loads `.env` and
      // `bunfig.toml` from the current directory, putting a project's secrets into Dovet's environment and its
      // child processes. Never remove; test/platform/compile-flags guards it.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  // Metafile paths are relative to the working directory.
  return Object.keys(result.metafile?.inputs ?? {}).map((p) => resolve(p));
}

/** The SPIKE-4 terminal demo (scripts/tui-demo.ts), with the same compile options. Not part of `dovet`. */
export async function compileTuiDemo(opts: { outfile: string }): Promise<void> {
  await compileDovet({ entry: join(ROOT, "scripts", "tui-demo.ts"), outfile: opts.outfile });
}

if (import.meta.main) {
  const demo = Bun.argv.indexOf("--tui-demo");
  const outfile =
    demo >= 0 ? Bun.argv[demo + 1] : join(ROOT, "dist", process.platform === "win32" ? "dovet.exe" : "dovet");
  if (!outfile) throw new Error("usage: bun scripts/build.ts [--tui-demo <outfile>]");
  await (demo >= 0 ? compileTuiDemo({ outfile }) : compileDovet({ outfile }));
  console.log(`built ${outfile}`);
}
