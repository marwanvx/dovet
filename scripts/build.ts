// `bun run build`: compile `dovet` for the current OS into dist/ (architecture "Distribution").
//
//     bun run build            # dist/dovet (dist/dovet.exe on Windows)
//
// compileDovet() holds the compile options; the compile-flags test and build-release.ts build with it.
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export async function compileDovet(opts: {
  outfile: string;
  entry?: string;
  target?: Bun.Build.CompileTarget;
}): Promise<void> {
  // Bun.build rejects with the build errors when compiling fails (`throw` defaults to true).
  await Bun.build({
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
}

if (import.meta.main) {
  const outfile = join(ROOT, "dist", process.platform === "win32" ? "dovet.exe" : "dovet");
  await compileDovet({ outfile });
  console.log(`built ${outfile}`);
}
