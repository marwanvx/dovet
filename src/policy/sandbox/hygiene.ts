// Sandbox configuration hygiene (permissions §7.5b).
import { lstat, readlink } from "node:fs/promises";
import { dirname as nativeDirname, resolve as nativeResolve } from "node:path";
import { dirname, isAbsolute, join } from "node:path/posix";
import {
  canonicalCmdlet,
  needsExactRule,
  normalizeShellPattern,
  shellPattern,
  shellVariants,
  splitCommand,
} from "../rules/shell.ts";

/** Expand `~`, strip trailing slashes, accept absolute paths with or without a `//` prefix. */
export function normalizeSandboxPath(raw: string, home: string): string {
  // Sandbox paths are POSIX form on every OS (permissions §3.3): normalize Windows `\` first.
  let p = raw.trim().replace(/\\/g, "/");
  const posixHome = home.replace(/\\/g, "/");
  if (p === "~") return posixHome;
  if (p.startsWith("~/")) p = join(posixHome, p.slice(2));
  if (p.startsWith("/")) p = `/${p.replace(/^\/+/, "")}`;
  if (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) p = p.replace(/[/\\]+$/, "");
  if (p.length > 3 && /^[A-Za-z]:[/\\]$/.test(p)) p = p.slice(0, 3).replace(/[/\\]$/, "");
  return p;
}

/** Normalize a host entry: strip trailing dots, bracket bare IPv6, reject ambiguous spellings. */
export function normalizeHost(raw: string): { ok: true; host: string } | { ok: false; reason: string } {
  const t = raw.trim().toLowerCase();
  if (t === "") return { ok: false, reason: "empty host" };
  if (/[\s/?#@]/.test(t)) return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
  const noDot = t.replace(/\.+$/, "");
  if (noDot === "" || noDot.includes("..")) return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
  if (noDot.startsWith("[") !== noDot.includes("]"))
    return { ok: false, reason: `unbalanced brackets in ${JSON.stringify(raw)}` };
  if (noDot.startsWith("[")) {
    const close = noDot.indexOf("]");
    const inside = noDot.slice(1, close);
    const rest = noDot.slice(close + 1);
    if (inside === "" || /[\s/?#@]/.test(inside)) return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
    if (rest !== "" && !/^:\d+$/.test(rest)) return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
    return { ok: true, host: noDot };
  }
  const colons = (noDot.match(/:/g) ?? []).length;
  if (colons > 1) return { ok: true, host: `[${noDot}]` };
  if (colons === 1) {
    const [h, port] = noDot.split(":");
    if (h === undefined || h === "" || port === undefined || !/^\d+$/.test(port)) {
      if ((h ?? "").includes(":")) return { ok: true, host: `[${noDot}]` };
      return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
    }
    if (h.includes("..") || h === "") return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
    return { ok: true, host: noDot };
  }
  if (noDot.startsWith(".") || noDot.startsWith("-") || noDot.endsWith("-")) {
    return { ok: false, reason: `ambiguous host ${JSON.stringify(raw)}` };
  }
  return { ok: true, host: noDot };
}

const gitCloneWithBranch = (argv: string[]): string[] => {
  const base = argv[argv.length - 1] === undefined ? argv : argv;
  const name = base[0]?.split("/").pop()?.toLowerCase();
  if (name !== "git" && name !== "git.exe") return argv;
  const out = [...argv];
  const cloneIdx = out.indexOf("clone");
  if (cloneIdx < 0) return argv;
  for (let i = cloneIdx + 1; i < out.length; i++) {
    if (out[i] === "-b" && i + 1 < out.length) out[i] = "--branch";
  }
  return out;
};

/** An excluded compound command runs unsandboxed only when every part matches (permissions §7.5). */
export function isExcludedCommand(
  command: string,
  excluded: readonly string[],
  tool: "Bash" | "PowerShell" = "Bash",
): boolean {
  if (excluded.length === 0) return false;
  const subs = splitCommand(command);
  if (subs === undefined || subs.length === 0) return false;
  return subs.every((sub) => {
    const branched = gitCloneWithBranch(sub.argv);
    const argv =
      tool === "PowerShell" && branched.length > 0
        ? [canonicalCmdlet(branched[0] ?? ""), ...branched.slice(1)]
        : branched;
    return excluded.some((pat) => {
      const text = normalizeShellPattern(pat);
      const pattern = tool === "PowerShell" ? text.replace(/^[^\s*]+/, (m) => canonicalCmdlet(m)) : text;
      const re = shellPattern(pattern, tool === "PowerShell");
      const variants = shellVariants(argv, false);
      if (text.includes("*") && variants.some((t) => needsExactRule(t.split(" ")))) return false;
      return variants.some((t) => re.test(t));
    });
  });
}

const STARTUP_FILES = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".envrc",
];

const isAbs = (p: string): boolean => isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p);

/** Anchored sandbox write denies (permissions §7.2): `.git/hooks` and `.git/config`, never bare `hooks/` or `config/`. */
export function sandboxProtectedDenyWrite(
  workingDirs: readonly string[],
  configDir: string,
  dataDir: string,
): string[] {
  // Config paths are POSIX form on every OS (permissions §3.3).
  const wds = workingDirs.map((w) => w.replace(/\\/g, "/"));
  const cfg = configDir.replace(/\\/g, "/");
  const data = dataDir.replace(/\\/g, "/");
  const out = new Set<string>();
  const parentsOf = (dir: string): string[] => {
    const out: string[] = [];
    let cur = dir.replace(/\\/g, "/");
    for (let i = 0; i < 20; i++) {
      out.push(cur);
      const parent = dirname(cur);
      if (parent === cur || /^[A-Za-z]:\/?$/.test(cur) || cur === "/") break;
      cur = parent;
    }
    return out;
  };
  for (const wd of wds) {
    for (const parent of parentsOf(wd)) {
      out.add(join(parent, ".dovet"));
      out.add(join(parent, ".dovet", "settings.json"));
      out.add(join(parent, ".dovet", "settings.local.json"));
      out.add(join(parent, ".claude"));
      out.add(join(parent, ".claude", "settings.json"));
      out.add(join(parent, ".mcp.json"));
    }
    for (const f of STARTUP_FILES) out.add(join(wd, f));
    out.add(join(wd, ".gitconfig"));
    out.add(join(wd, ".vscode"));
    out.add(join(wd, ".idea"));
    out.add(join(wd, ".git", "hooks"));
    out.add(join(wd, ".git", "config"));
    out.add(join(wd, "HEAD"));
    out.add(join(wd, "objects"));
    out.add(join(wd, "refs"));
  }
  if (isAbs(cfg)) out.add(cfg);
  if (isAbs(data)) out.add(data);
  return [...out];
}

/** In a linked worktree, the common git dir's objects/refs/logs stay usable; only hooks/ and config are denied. */
export function worktreeCommonDenies(commonDir: string): string[] {
  const posix = commonDir.replace(/\\/g, "/");
  return [join(posix, "hooks"), join(posix, "config")];
}

/** Deny both the link and its target; missing paths are dropped and never stop the sandbox from starting. */
export async function expandProtectedSymlinks(paths: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const p of paths) {
    const posix = p.replace(/\\/g, "/");
    out.add(posix);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        // Native fs semantics: resolve the target the same way the OS does so the
        // returned string matches what callers passed in on every platform.
        const target = nativeResolve(nativeDirname(p), await readlink(p)).replace(/\\/g, "/");
        out.add(target);
      }
    } catch {}
  }
  return [...out];
}
