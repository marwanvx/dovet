// Built by compile-flags.test.ts with Dovet's own compile options (scripts/build.ts) to show what a compiled
// binary leaks into child processes. Run as `probe <child-cwd>`: prints its own X_TEST, then starts itself as a
// child in <child-cwd> (a directory without `.env`) and prints what the child inherited.
const [mode, childCwd] = process.argv.slice(2);
if (mode === "child") {
  console.log(`child X_TEST=${process.env.X_TEST ?? "<absent>"}`);
} else {
  console.log(`self X_TEST=${process.env.X_TEST ?? "<absent>"}`);
  const child = Bun.spawnSync([process.execPath, "child"], { cwd: childCwd ?? process.cwd() });
  process.stdout.write(child.stdout);
}
