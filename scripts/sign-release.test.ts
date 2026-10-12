import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSha256Sums, verifiedSha256Sums } from "../src/cli/release-signature.ts";
import { signRelease } from "./sign-release.ts";

const work = mkdtempSync(join(tmpdir(), "dovet-sign-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  return {
    privateKey: b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

function releaseDir(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SHA256SUMS"),
    formatSha256Sums([{ name: "dovet-1.0.0-linux-x64.tar.gz", sha256: "e".repeat(64) }]),
  );
  return dir;
}

describe("signRelease", () => {
  test("writes a signature of SHA256SUMS that verifies against the key's public half", async () => {
    const k = await keys();
    const dir = releaseDir("ok");
    await signRelease(dir, k.privateKey, [k.publicKey]);
    const sums = await verifiedSha256Sums(
      await Bun.file(join(dir, "SHA256SUMS")).bytes(),
      await Bun.file(join(dir, "SHA256SUMS.sig")).bytes(),
      [k.publicKey],
    );
    expect(sums.get("dovet-1.0.0-linux-x64.tar.gz")).toBe("e".repeat(64));
  });

  test("refuses a key whose public half isn't trusted, and writes no signature", async () => {
    const k = await keys();
    const other = await keys();
    const dir = releaseDir("untrusted");
    await expect(signRelease(dir, k.privateKey, [other.publicKey])).rejects.toThrow("does not verify");
    expect(existsSync(join(dir, "SHA256SUMS.sig"))).toBe(false);
  });
});
