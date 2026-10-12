// THIRD_PARTY_NOTICES of one release archive (AC-ARCH-05, ADR-15): every bundled npm package, the Bun runtime,
// the sandbox-runtime helpers, ripgrep and vendored code, each with its license text and NOTICE file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { RIPGREP_VERSION, type Target } from "./build-release.ts";

const ROOT = join(import.meta.dir, "..");

type Notice = { title: string; source: string; license: string; texts: string[] };

function packageJson(dir: string): { name: string; version: string; license?: string; homepage?: string } {
  const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const field = (key: string) => {
    const v = typeof pkg === "object" && pkg !== null ? (pkg as Record<string, unknown>)[key] : undefined;
    return typeof v === "string" ? v : undefined;
  };
  const name = field("name");
  const version = field("version");
  if (!name || !version) throw new Error(`${dir}/package.json has no name or version`);
  const license = field("license");
  const homepage = field("homepage");
  return { name, version, ...(license ? { license } : {}), ...(homepage ? { homepage } : {}) };
}

/** The npm package directories the bundled files belong to (innermost `node_modules/<name>`), sorted, once each. */
export function bundledPackageDirs(inputs: string[]): string[] {
  const dirs = new Set<string>();
  const marker = `${sep}node_modules${sep}`;
  for (const file of inputs) {
    const at = file.lastIndexOf(marker);
    if (at < 0) continue;
    const parts = file.slice(at + marker.length).split(sep);
    const name = parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
    dirs.add(join(file.slice(0, at + marker.length), ...name));
  }
  return [...dirs].sort();
}

function filesMatching(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim());
}

function npmNotice(dir: string): Notice {
  const pkg = packageJson(dir);
  const licenses = filesMatching(dir, /^(licen[cs]e|copying|unlicense)([.-].*)?$/i);
  if (licenses.length === 0) throw new Error(`${pkg.name} ${pkg.version} has no license file (${dir})`);
  return {
    title: `${pkg.name} ${pkg.version}`,
    source: pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`,
    license: pkg.license ?? "see text",
    texts: [...licenses, ...filesMatching(dir, /^notice([.-].*)?$/i)],
  };
}

function bunNotice(): Notice {
  const file = join(import.meta.dir, "licenses", `bun-${Bun.version}-LICENSE.md`);
  if (!existsSync(file)) throw new Error(`no license text for Bun ${Bun.version}: add ${file} from its release tag`);
  return {
    title: `Bun ${Bun.version} (the runtime inside the dovet executable)`,
    source: `https://github.com/oven-sh/bun/blob/bun-v${Bun.version}/LICENSE.md`,
    license: "MIT, with statically linked libraries listed below",
    texts: [readFileSync(file, "utf8").trim()],
  };
}

function render(notices: Notice[]): string {
  const rule = "=".repeat(80);
  const thin = "-".repeat(80);
  const header = "Third-party notices for Dovet: the software bundled in this install directory and its licenses.";
  const blocks = notices.map((n) =>
    [rule, n.title, n.source, `License: ${n.license}`, thin, n.texts.join(`\n\n${thin}\n\n`)].join("\n"),
  );
  return `${[header, ...blocks].join("\n\n")}\n`;
}

/**
 * The notices file for `target`'s archive. `inputs` are the absolute paths of every file compiled into the executable
 * (Bun's metafile); `ripgrepLicense` is the license shipped in the pinned ripgrep archive, or null when the target has
 * no ripgrep. Throws if anything bundled has no license.
 */
export async function releaseNotices(opts: {
  inputs: string[];
  target: Target;
  ripgrepLicense: string | null;
}): Promise<string> {
  const notices = [bunNotice(), ...bundledPackageDirs(opts.inputs).map(npmNotice)];
  const srt = npmNotice(join(ROOT, "node_modules", "@anthropic-ai", "sandbox-runtime"));
  if (!notices.some((n) => n.title === srt.title))
    notices.push({ ...srt, title: `${srt.title} (libexec/srt helpers)` });
  if (opts.target.ripgrep) {
    if (!opts.ripgrepLicense) throw new Error(`${opts.target.id} bundles ripgrep but its license text is missing`);
    notices.push({
      title: `ripgrep ${RIPGREP_VERSION} (libexec/rg)`,
      source: "https://github.com/BurntSushi/ripgrep",
      license: "MIT (dual-licensed MIT or Unlicense; Dovet uses it under MIT)",
      texts: [opts.ripgrepLicense.trim()],
    });
  }
  notices.push({
    title: "pi-tui 1.1.0 (vendored in Dovet's source, src/tui/vendor/pi-tui)",
    source: "https://github.com/earendil-works/pi (packages/tui)",
    license: "MIT",
    texts: [readFileSync(join(ROOT, "src", "tui", "vendor", "pi-tui", "LICENSE"), "utf8").trim()],
  });
  return render(notices);
}
