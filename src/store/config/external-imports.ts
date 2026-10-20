// One-time approval of external instruction imports, per project (context §3 "Imports").
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isErrno } from "../../platform/index.ts";
import { writeFileAtomic } from "./atomic.ts";

const Decisions = z.record(z.string(), z.boolean());

export type ExternalImportApprovals = {
  decision(path: string): Promise<boolean | undefined>;
  record(paths: readonly string[], approved: boolean): Promise<void>;
};

// ASSUMPTION (QUESTIONS Q30): `file` is `<data>/projects/<projectId>/external-imports.json`.
export function externalImportApprovals(file: string): ExternalImportApprovals {
  const load = async (): Promise<Record<string, boolean>> => {
    const text = await readFile(file, "utf8").catch((e: unknown) => (isErrno(e, "ENOENT") ? "{}" : Promise.reject(e)));
    // A damaged file means asking again, the safe direction.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      return {};
    }
    const parsed = Decisions.safeParse(json);
    return parsed.success ? parsed.data : {};
  };
  return {
    decision: async (path) => (await load())[path],
    async record(paths, approved) {
      const all = await load();
      for (const p of paths) all[p] = approved;
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
    },
  };
}
