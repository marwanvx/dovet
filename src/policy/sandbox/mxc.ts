// Windows MXC backend mapping and availability (permissions §7.6, ADR-6, SPIKE-42).
export type MxcSupport = { supported: boolean; detail: string };
export type MxcLoader = () => Promise<{ getPlatformSupport(): unknown }>;

async function defaultLoader(): Promise<{ getPlatformSupport(): unknown }> {
  // Variable import so the optional SDK stays out of package.json (ADR-15); when it ships in
  // libexec/mxc this must become a literal for --compile to bundle it (test/platform/mxc/mxc-probe.ts).
  const name = "@microsoft/mxc-sdk/v1";
  const mod = (await import(name)) as { getPlatformSupport(): unknown };
  return mod;
}

export async function checkMxcSupport(loader: MxcLoader = defaultLoader): Promise<MxcSupport> {
  try {
    const sdk = await loader();
    const support = sdk.getPlatformSupport() as { isSupported?: boolean } | undefined;
    if (support?.isSupported === true) return { supported: true, detail: "MXC is supported on this host" };
    return { supported: false, detail: "MXC is not supported on this host" };
  } catch (e) {
    return { supported: false, detail: `MXC SDK unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function mxcConfigFor(opts: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] }): {
  readwritePaths: string[];
  deniedPaths: string[];
} {
  return {
    readwritePaths: [...opts.allowWrite],
    deniedPaths: [...new Set([...opts.denyRead, ...opts.denyWrite])],
  };
}
