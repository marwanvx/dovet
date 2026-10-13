import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "../../platform/index.ts";

export interface BlobStore {
  /** Returns the SHA-256 the bytes are stored under; an existing blob is never rewritten. */
  putSync(bytes: Uint8Array): string;
  /** Undefined when missing; throws when the bytes don't match the name. */
  get(sha: string): Promise<Uint8Array | undefined>;
}

/** Content-addressed blob store at `<data>/blobs/<sha256[0..2]>/<sha256>` (event-log "Blob store"). */
export function createBlobStore(data: string): BlobStore {
  const root = join(data, "blobs");
  const pathOf = (sha: string): string => join(root, sha.slice(0, 2), sha);

  return {
    putSync(bytes) {
      const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const path = pathOf(sha);
      try {
        statSync(path);
        return sha;
      } catch (err) {
        if (!isErrno(err, "ENOENT")) throw err;
      }
      mkdirSync(join(root, sha.slice(0, 2)), { recursive: true, mode: 0o700 });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temp, bytes, { mode: 0o600 });
        renameSync(temp, path);
      } catch (err) {
        rmSync(temp, { force: true });
        throw err;
      }
      return sha;
    },

    async get(sha) {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(pathOf(sha));
      } catch (err) {
        if (isErrno(err, "ENOENT")) return undefined;
        throw err;
      }
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha) throw new Error(`blob ${sha} is damaged`);
      return bytes;
    },
  };
}
