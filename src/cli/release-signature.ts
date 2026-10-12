// Release authenticity (architecture "Distribution"): SHA256SUMS is trusted only after its Ed25519 signature verifies.

/** Base64 raw Ed25519 public keys whose signatures on SHA256SUMS are trusted. Empty until the owner creates the key. */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];

export function formatSha256Sums(entries: { name: string; sha256: string }[]): string {
  return entries.map((e) => `${e.sha256}  ${e.name}\n`).join("");
}

function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  lines.forEach((line, i) => {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!m?.[1] || !m[2] || sums.has(m[2])) throw new Error(`SHA256SUMS line ${i + 1} is not a checksum line`);
    sums.set(m[2], m[1]);
  });
  return sums;
}

/** File name to SHA-256 hex, once `signature` verifies against one of `publicKeys`; throws otherwise. */
export async function verifiedSha256Sums(
  sums: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  publicKeys: readonly string[],
): Promise<Map<string, string>> {
  for (const key of publicKeys) {
    const k = await crypto.subtle.importKey("raw", Buffer.from(key, "base64"), { name: "Ed25519" }, false, ["verify"]);
    if (await crypto.subtle.verify("Ed25519", k, signature, sums))
      return parseSha256Sums(new TextDecoder().decode(sums));
  }
  throw new Error("the SHA256SUMS signature does not verify against any trusted release key");
}
