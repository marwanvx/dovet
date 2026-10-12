// Signs a release's SHA256SUMS with the Ed25519 release key (architecture "Distribution": Release authenticity).
//
//     DOVET_RELEASE_KEY=<base64 PKCS#8> bun scripts/sign-release.ts <dir>   # writes <dir>/SHA256SUMS.sig
//     bun scripts/sign-release.ts <dir> --test-key   # a throwaway key (pull-request runs); prints test_public_key=…
//     bun scripts/sign-release.ts --new-key          # the owner, once: makes the release key pair
import { join } from "node:path";
import { RELEASE_PUBLIC_KEYS, verifiedSha256Sums } from "../src/cli/release-signature.ts";

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

async function newKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  return {
    privateKey: b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

/** Signs `dir`/SHA256SUMS with `privateKey` and checks the result against `trusted` before writing it. */
export async function signRelease(dir: string, privateKey: string, trusted: readonly string[]): Promise<void> {
  if (trusted.length === 0) throw new Error("no release public key is embedded yet (RELEASE_PUBLIC_KEYS)");
  const sums = await Bun.file(join(dir, "SHA256SUMS")).bytes();
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(privateKey, "base64"), { name: "Ed25519" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, sums));
  // A key that isn't embedded in Dovet would sign a release no install could verify.
  await verifiedSha256Sums(sums, sig, trusted);
  await Bun.write(join(dir, "SHA256SUMS.sig"), sig);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.includes("--new-key")) {
    const { privateKey, publicKey } = await newKeyPair();
    console.log(
      `Private key (the GitHub secret DOVET_RELEASE_KEY; keep an offline copy, never share it):\n${privateKey}\n`,
    );
    console.log(`Public key (send this one to the agent; it goes into Dovet):\n${publicKey}`);
  } else {
    const dir = args.find((a) => !a.startsWith("--"));
    if (!dir) throw new Error("usage: bun scripts/sign-release.ts <dir> [--test-key] | --new-key");
    if (args.includes("--test-key")) {
      const { privateKey, publicKey } = await newKeyPair();
      await signRelease(dir, privateKey, [publicKey]);
      console.log(`test_public_key=${publicKey}`);
    } else {
      const privateKey = Bun.env.DOVET_RELEASE_KEY;
      if (!privateKey) throw new Error("DOVET_RELEASE_KEY is not set");
      await signRelease(dir, privateKey, RELEASE_PUBLIC_KEYS);
      console.log(`signed ${join(dir, "SHA256SUMS")}`);
    }
  }
}
