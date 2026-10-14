// The write strategy Write and Edit share (tools §2 step 7): atomic replace, in-place when identity matters, verified.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { isErrno, type Os } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";

export type WriteHooks = {
  rename?: (from: string, to: string) => Promise<void>;
  write?: (handle: FileHandle, data: Uint8Array) => Promise<void>;
  beforeRename?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};
export type WriteOptions = { os: Os; keepHardLink?: boolean; hooks?: WriteHooks | undefined };
export type WriteOutcome = { ok: true; notes: string[] } | { ok: false; message: string; appeared?: true };

const VERIFY_LIMIT = 10 * 1024 * 1024;
const BACKOFF_MS = [50, 100, 200, 400, 800];
const LOCKED = ["EPERM", "EACCES", "EBUSY"] as const;
const defaultWrite = (h: FileHandle, data: Uint8Array): Promise<void> => h.writeFile(data);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Identity = { dev: bigint; ino: bigint };
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;

export async function writeBytes(path: AbsPath, data: Uint8Array, opts: WriteOptions): Promise<WriteOutcome> {
  const hooks = opts.hooks ?? {};
  const write = hooks.write ?? defaultWrite;
  const dir = dirname(path);
  const dirBefore = await stat(dir, { bigint: true });
  const existing = await lstat(path, { bigint: true }).catch((e: unknown) => {
    if (isErrno(e, "ENOENT")) return undefined;
    throw e;
  });
  const notes: string[] = [];

  async function viaTemp(mode: number | undefined, onlyIfAbsent: boolean): Promise<"done" | "exists" | "busy"> {
    const temp = join(dir, `.${basename(path)}.dovet-${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
    try {
      try {
        if (mode !== undefined) await handle.chmod(mode);
        await write(handle, data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await hooks.beforeRename?.();
      const dirNow = await stat(dir, { bigint: true });
      if (!sameIdentity(dirBefore, dirNow)) throw new DirectoryChanged(dir);
      if (onlyIfAbsent) {
        try {
          await link(temp, path);
          return "done";
        } catch (e) {
          if (isErrno(e, "EEXIST")) return "exists";
          if (!isErrno(e, "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK")) throw e;
        }
      }
      return (await renameWithRetry(temp)) ? "done" : "busy";
    } finally {
      await unlink(temp).catch((e: unknown) => {
        if (!isErrno(e, "ENOENT")) throw e;
      });
    }
  }

  async function renameWithRetry(temp: string): Promise<boolean> {
    const doRename = hooks.rename ?? rename;
    const sleep = hooks.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        await doRename(temp, path);
        return true;
      } catch (e) {
        if (isErrno(e, "EBUSY", "EXDEV") && opts.os !== "win32") return false;
        if (opts.os !== "win32" || !isErrno(e, ...LOCKED)) throw e;
        const delay = BACKOFF_MS[attempt];
        if (delay === undefined) return false;
        await sleep(delay);
      }
    }
  }

  async function inPlace(): Promise<void> {
    if (!sameIdentity(dirBefore, await stat(dir, { bigint: true }))) throw new DirectoryChanged(dir);
    const handle = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await write(handle, data);
      await handle.truncate(data.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function verified(): Promise<boolean> {
    const st = await stat(path);
    if (st.size !== data.length) return false;
    if (data.length > VERIFY_LIMIT) return true;
    return Buffer.compare(await readFile(path), data) === 0;
  }

  try {
    let reason: string | undefined;
    let replaced = false;
    let busy = false;
    if (existing === undefined) {
      const made = await viaTemp(undefined, true);
      if (made === "exists")
        return {
          ok: false,
          appeared: true,
          message: `${path} appeared while it was being written; nothing was written.`,
        };
      replaced = made === "done";
      if (!replaced) reason = "its mount";
    } else {
      const mode = Number(existing.mode & 0o7777n);
      const owner = userInfo().uid;
      const foreign = owner !== -1 && Number(existing.uid) !== owner;
      if (existing.nlink > 1n && opts.keepHardLink) reason = "the hard link";
      else if (existing.dev !== dirBefore.dev) reason = "its mount";
      else if (foreign) reason = "its owner";
      else if ((mode & 0o7000) !== 0) reason = "its special mode bits";
      if (reason === undefined) {
        replaced = (await viaTemp(mode, false)) === "done";
        if (!replaced && opts.os === "win32") busy = true;
        else if (!replaced) reason = "its mount";
        else if (existing.nlink > 1n)
          notes.push(
            `This file had ${existing.nlink} hard links; Dovet wrote a new file, so the other links keep the old content.`,
          );
      }
    }
    if (!replaced) {
      try {
        await inPlace();
      } catch (e) {
        if (opts.os === "win32" && isErrno(e, ...LOCKED))
          return { ok: false, message: `${path} is locked by another program (${messageOf(e)}).` };
        throw e;
      }
      notes.push(
        busy
          ? "Written in place because another program has the file open."
          : `Written in place to keep ${reason ?? "its identity"}.`,
      );
    }
    if (await verified()) return { ok: true, notes };
    await inPlace();
    if (await verified()) return { ok: true, notes: [...notes, "A first write came out short; the retry succeeded."] };
    return {
      ok: false,
      message: `${path} did not read back as written (a network drive or cloud-synced folder such as OneDrive or Dropbox may be changing it). The old content is in the checkpoint.`,
    };
  } catch (e) {
    if (e instanceof DirectoryChanged)
      return { ok: false, message: `${e.message} changed while writing; nothing was written. Try again.` };
    throw e;
  }
}

class DirectoryChanged extends Error {}
