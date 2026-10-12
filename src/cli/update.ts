// `dovet update` and `--rollback` (architecture "Distribution"; cli-config "Install, PATH and uninstall").
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { verifiedSha256Sums } from "./release-signature.ts";

export const LATEST_RELEASE_URL = "https://github.com/marwanvx/dovet/releases/latest/download";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export type UpdateResult =
  | { status: "updated"; from: string; to: string; pruneErrors: string[] }
  | { status: "current"; version: string };

export function hostTargetId(os: string, arch: string, musl: boolean): string {
  const name = { linux: "linux", darwin: "darwin", win32: "windows" }[os];
  if (!name || (arch !== "x64" && arch !== "arm64")) throw new Error(`no Dovet release for ${os} ${arch}`);
  return `${name}-${arch}${os === "linux" && musl ? "-musl" : ""}`;
}

export function detectMusl(): boolean {
  return existsSync("/lib") && readdirSync("/lib").some((f) => f.startsWith("ld-musl-"));
}

/** The install directory (holding `versions/` and `current`) of a dovet executable, from its real path. */
export function installRootFor(execPath: string): string {
  const dir = dirname(execPath);
  if (basename(dir) === "current") return dirname(dir);
  if (basename(dirname(dir)) === "versions") return dirname(dirname(dir));
  throw new Error("this dovet was not installed by the install script, so it can't update itself");
}

function installedVersion(root: string): string {
  const link = join(root, "current");
  if (!existsSync(link)) throw new Error(`no install found: ${link} is missing`);
  const version = basename(readlinkSync(link));
  if (!VERSION.test(version)) throw new Error(`${link} points at ${version}, which is not a version directory`);
  return version;
}

function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function removeLink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path);
}

/** Points `current` at `versions/<version>`: a rename over the old symlink on POSIX, a swapped junction on Windows. */
function pointCurrent(root: string, version: string, os: string): void {
  const current = join(root, "current");
  const dir = join(root, "versions", version);
  if (os !== "win32") {
    const next = join(root, `current.${process.pid}.new`);
    removeLink(next);
    symlinkSync(join("versions", version), next);
    renameSync(next, current);
    return;
  }
  // Windows can't rename over a directory link, so the old junction is set aside and put back if the new one fails.
  const old = join(root, "current.old");
  removeLink(old);
  const hadCurrent = lstatSync(current, { throwIfNoEntry: false }) !== undefined;
  if (hadCurrent) renameSync(current, old);
  try {
    symlinkSync(dir, current, "junction");
  } catch (err) {
    if (hadCurrent) renameSync(old, current);
    throw err;
  }
  removeLink(old);
}

function writePrevious(root: string, version: string): void {
  const tmp = join(root, "previous.new");
  writeFileSync(tmp, `${version}\n`);
  renameSync(tmp, join(root, "previous"));
}

async function download(url: string, what: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloading ${what} (${url}): HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Archive entries must stay under `dovet/`; the unpacked tree must hold no links. */
async function unpack(archive: Uint8Array<ArrayBuffer>, into: string): Promise<void> {
  const tar = new Bun.Archive(archive);
  for (const path of (await tar.files()).keys()) {
    const parts = path.split("/");
    if (parts[0] !== "dovet" || parts.some((p) => p === ".." || p.includes("\\") || p.includes(":")))
      throw new Error(`the archive holds a file outside dovet/: ${path}`);
  }
  await tar.extract(into);
  for (const entry of readdirSync(into, { recursive: true, withFileTypes: true }))
    if (entry.isSymbolicLink()) throw new Error(`the archive holds a link: ${join(entry.parentPath, entry.name)}`);
}

/** Installs the latest signed release under `versions/` and points `current` at it; the old version stays for `--rollback`. */
export async function update(opts: {
  root: string;
  baseUrl: string;
  targetId: string;
  os: string;
  publicKeys: readonly string[];
}): Promise<UpdateResult> {
  const { root, os } = opts;
  const installed = installedVersion(root);
  const sums = await download(`${opts.baseUrl}/SHA256SUMS`, "SHA256SUMS");
  const signature = await download(`${opts.baseUrl}/SHA256SUMS.sig`, "SHA256SUMS.sig");
  const signed = await verifiedSha256Sums(sums, signature, opts.publicKeys);

  const suffix = `-${opts.targetId}.tar.gz`;
  const candidates = [...signed]
    .filter(([name]) => name.startsWith("dovet-") && name.endsWith(suffix))
    .map(([name, sha256]) => ({ name, sha256, version: name.slice("dovet-".length, -suffix.length) }))
    .filter((c) => VERSION.test(c.version))
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = candidates[0];
  if (!latest) throw new Error(`the latest release has no archive for ${opts.targetId}`);
  if (compareVersions(latest.version, installed) <= 0) return { status: "current", version: installed };

  const archive = await download(`${opts.baseUrl}/${latest.name}`, latest.name);
  if (new Bun.CryptoHasher("sha256").update(archive).digest("hex") !== latest.sha256)
    throw new Error(`the checksum of ${latest.name} does not match the signed SHA256SUMS`);

  const versions = join(root, "versions");
  const scratch = mkdtempSync(join(versions, ".new-"));
  try {
    await unpack(archive, scratch);
    const exe = os === "win32" ? "dovet.exe" : "dovet";
    if (!existsSync(join(scratch, "dovet", exe))) throw new Error(`the archive has no dovet/${exe}`);
    const dest = join(versions, latest.version);
    rmSync(dest, { recursive: true, force: true });
    renameSync(join(scratch, "dovet"), dest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  pointCurrent(root, latest.version, os);
  writePrevious(root, installed);

  const pruneErrors: string[] = [];
  for (const name of readdirSync(versions)) {
    if (name === latest.version || name === installed) continue;
    try {
      rmSync(join(versions, name), { recursive: true, force: true });
    } catch (err) {
      pruneErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { status: "updated", from: installed, to: latest.version, pruneErrors };
}

/** Switches `current` back to the version it pointed at before the last update (or rollback). */
export function rollback(opts: { root: string; os: string }): { from: string; to: string } {
  const { root } = opts;
  const from = installedVersion(root);
  const file = join(root, "previous");
  const to = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!VERSION.test(to)) throw new Error("there is no previous version to roll back to");
  if (!existsSync(join(root, "versions", to))) throw new Error(`version ${to} is no longer installed`);
  pointCurrent(root, to, opts.os);
  writePrevious(root, from);
  return { from, to };
}
