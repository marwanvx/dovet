import type { Ulid } from "../../src/schema/index.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Valid, unique, increasing ULIDs; `seed` (1–4 Crockford characters) keeps two generators apart. */
export function sequentialIds(seed = "0"): { ulid(): Ulid } {
  if (!/^[0-9A-HJKMNP-TV-Z]{1,4}$/.test(seed)) throw new Error(`sequentialIds: bad seed ${JSON.stringify(seed)}`);
  let count = 0;
  return {
    ulid() {
      count += 1;
      let n = count;
      let tail = "";
      while (n > 0) {
        tail = CROCKFORD.charAt(n % 32) + tail;
        n = Math.floor(n / 32);
      }
      return `${"0".repeat(10)}${seed.padStart(4, "0")}${tail.padStart(12, "0")}`;
    },
  };
}
