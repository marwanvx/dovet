// The OS line of the environment block (context §2): "Ubuntu 24.04.1 LTS", "macOS 15.3", "Windows 11 (build 26100)".
import { readFile } from "node:fs/promises";
import { isErrno } from "./errno.ts";
import type { Os } from "./types.ts";

export async function describeOs(
  os: Os,
  release: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<string> {
  const tryRead = async (path: string): Promise<string | undefined> => {
    try {
      return await read(path);
    } catch (e) {
      if (isErrno(e, "ENOENT", "EACCES", "ENOTDIR")) return undefined;
      throw e;
    }
  };
  if (os === "win32") {
    const build = Number(release.split(".")[2]);
    if (!Number.isInteger(build)) return `Windows ${release}`;
    return `Windows ${build >= 22000 ? "11" : "10"} (build ${build})`;
  }
  if (os === "darwin") {
    const plist = await tryRead("/System/Library/CoreServices/SystemVersion.plist");
    const version = plist?.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    return version === undefined ? `macOS (Darwin ${release})` : `macOS ${version}`;
  }
  const text = (await tryRead("/etc/os-release")) ?? (await tryRead("/usr/lib/os-release"));
  const pretty = text?.match(/^PRETTY_NAME=(?:"([^"]*)"|'([^']*)'|(.*))$/m);
  const name = pretty?.[1] ?? pretty?.[2] ?? pretty?.[3];
  return name === undefined || name.trim() === "" ? `Linux ${release}` : name.trim();
}
