import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "../../platform/index.ts";
import { writePrivateAtomic } from "./files.ts";
import { emptyMeta, foldMeta, SessionMeta } from "./meta.ts";
import { type ProjectLocation, sessionPaths, sessionsDir } from "./paths.ts";
import { readSession } from "./reader.ts";

async function readSidecar(path: string): Promise<SessionMeta | undefined> {
  try {
    const parsed = SessionMeta.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch (err) {
    if (isErrno(err, "ENOENT") || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** The project's sessions, oldest first; a missing or stale sidecar is rebuilt from the log (event-log "No database"). */
export async function listSessions(loc: ProjectLocation): Promise<SessionMeta[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir(loc));
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  const out: SessionMeta[] = [];
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    const session = name.slice(0, -".jsonl".length);
    const paths = sessionPaths({ ...loc, session });
    const bytes = (await stat(join(paths.dir, name))).size;
    const cached = await readSidecar(paths.meta);
    if (cached !== undefined && cached.bytes === bytes) {
      out.push(cached);
      continue;
    }
    const { events } = await readSession({ ...loc, session });
    const meta = { ...events.reduce(foldMeta, emptyMeta(session)), bytes };
    await writePrivateAtomic(paths.meta, `${JSON.stringify(meta)}\n`);
    out.push(meta);
  }
  return out;
}
