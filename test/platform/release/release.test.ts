// The release workflow's own check of a built release (release.yml, job `verify`): DOVET_RELEASE_DIR holds the
// downloaded release files. Skipped elsewhere: attestations exist only for archives a release run built.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS } from "../../../scripts/build-release.ts";
import { RELEASE_PUBLIC_KEYS, verifiedSha256Sums } from "../../../src/cli/release-signature.ts";

const dir = process.env.DOVET_RELEASE_DIR;
const repo = process.env.GITHUB_REPOSITORY ?? "marwanvx/dovet";
// Test releases (pull requests) are signed with a throwaway key; real ones with an embedded key.
const testKey = process.env.DOVET_RELEASE_TEST_PUBLIC_KEY;
const archives = dir ? readdirSync(dir).filter((f) => f.endsWith(".tar.gz")) : [];

function ghVerify(file: string) {
  return Bun.spawnSync(
    ["gh", "attestation", "verify", file, "--repo", repo, "--signer-workflow", `${repo}/.github/workflows/release.yml`],
    { stdout: "pipe", stderr: "pipe" },
  );
}

describe.skipIf(!dir)("a built release", () => {
  test("has an archive for each of the eight targets", () => {
    expect(archives.map((f) => f.replace(/^dovet-[^-]+-/, "").replace(/\.tar\.gz$/, "")).sort()).toEqual(
      TARGETS.map((t) => t.id).sort(),
    );
  });

  test("SHA256SUMS is signed by a release key and matches every archive", async () => {
    if (!dir) return;
    const keys = testKey ? [testKey] : [...RELEASE_PUBLIC_KEYS];
    const sums = await verifiedSha256Sums(
      await Bun.file(join(dir, "SHA256SUMS")).bytes(),
      await Bun.file(join(dir, "SHA256SUMS.sig")).bytes(),
      keys,
    );
    expect([...sums.keys()].sort()).toEqual([...archives].sort());
    for (const f of archives) {
      const got = new Bun.CryptoHasher("sha256").update(await Bun.file(join(dir, f)).bytes()).digest("hex");
      expect(got).toBe(sums.get(f) ?? "");
    }
  });

  // spec: AC-ARCH-03
  test("every archive has a build-provenance attestation that gh attestation verify accepts", () => {
    if (!dir) return;
    expect(archives.length).toBe(TARGETS.length);
    for (const f of archives) {
      const r = ghVerify(join(dir, f));
      if (r.exitCode !== 0) throw new Error(`${f}: gh attestation verify failed: ${r.stderr.toString()}`);
      expect(r.stdout.toString()).toContain(f);
    }
  }, 120_000);

  // spec: AC-ARCH-03
  test("gh attestation verify refuses an archive changed after the build", () => {
    if (!dir) return;
    const first = archives[0];
    if (!first) throw new Error("no archives");
    const scratch = mkdtempSync(join(tmpdir(), "dovet-attest-"));
    try {
      const copy = join(scratch, first);
      copyFileSync(join(dir, first), copy);
      Bun.spawnSync(["sh", "-c", 'printf x >> "$1"', "sh", copy]);
      expect(ghVerify(copy).exitCode).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
