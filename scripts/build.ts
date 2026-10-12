// `bun run build`: compile `dovet` for the current OS into dist/ (architecture "Distribution").
//
//     bun run build            # dist/dovet (dist/dovet.exe on Windows)
//
// compileDovet() holds the compile options; the release build and the compile-flags test use it too.
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export async function compileDovet(opts: { outfile: string; entry?: string }): Promise<void> {
  const result = await Bun.build({
    entrypoints: [opts.entry ?? join(ROOT, "src", "cli", "main.ts")],
    compile: {
      outfile: opts.outfile,
      // Security-critical (architecture "Compile flags"): a compiled Bun executable otherwise loads `.env` and
      // `bunfig.toml` from the current directory, putting a project's secrets into Dovet's environment and its
      // child processes. Never remove; test/platform/compile-flags guards it.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `compiling ${opts.outfile} failed`);
  }
}

if (import.meta.main) {
  const outfile = join(ROOT, "dist", process.platform === "win32" ? "dovet.exe" : "dovet");
  await compileDovet({ outfile });
  console.log(`built ${outfile}`);
}
