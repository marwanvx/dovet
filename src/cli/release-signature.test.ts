import { describe, expect, test } from "bun:test";
import { formatSha256Sums, RELEASE_PUBLIC_KEYS, verifiedSha256Sums } from "./release-signature.ts";

const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  return { pair, publicKey: b64(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

const sums = enc.encode(
  formatSha256Sums([
    { name: "dovet-1.0.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
    { name: "dovet-1.0.0-windows-x64.tar.gz", sha256: "b".repeat(64) },
  ]),
);

describe("verifiedSha256Sums", () => {
  test("returns each archive's checksum when the signature verifies against a trusted key", async () => {
    const { pair, publicKey } = await keyPair();
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, sums));
    const other = await keyPair();
    const map = await verifiedSha256Sums(sums, sig, [other.publicKey, publicKey]);
    expect(map.get("dovet-1.0.0-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(map.get("dovet-1.0.0-windows-x64.tar.gz")).toBe("b".repeat(64));
  });

  test("refuses a SHA256SUMS changed after signing", async () => {
    const { pair, publicKey } = await keyPair();
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, sums));
    const tampered = sums.slice();
    tampered[0] = "c".charCodeAt(0);
    await expect(verifiedSha256Sums(tampered, sig, [publicKey])).rejects.toThrow("does not verify");
  });

  test("refuses a signature by a key that isn't trusted", async () => {
    const signer = await keyPair();
    const trusted = await keyPair();
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.pair.privateKey, sums));
    await expect(verifiedSha256Sums(sums, sig, [trusted.publicKey])).rejects.toThrow("does not verify");
  });

  test("refuses everything when no key is trusted", async () => {
    const { pair } = await keyPair();
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, sums));
    await expect(verifiedSha256Sums(sums, sig, [])).rejects.toThrow("does not verify");
  });

  test("refuses a signed file that isn't in SHA256SUMS format", async () => {
    const { pair, publicKey } = await keyPair();
    const bad = enc.encode("not a checksum line\n");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bad));
    await expect(verifiedSha256Sums(bad, sig, [publicKey])).rejects.toThrow("line 1");
  });

  test("every embedded release key is a 32-byte Ed25519 public key", () => {
    for (const key of RELEASE_PUBLIC_KEYS) expect(Buffer.from(key, "base64").length).toBe(32);
  });
});
