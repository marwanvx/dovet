import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { isErrno, type Os } from "../../platform/index.ts";
import { Secret } from "./secret.ts";

export type KeychainBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;
export type SecretLocation = "keychain" | "file";

export interface SecretStore {
  get(name: string): Promise<{ secret: Secret; location: SecretLocation } | undefined>;
  /** Returns where it was stored: the file only on Linux without a Secret Service. */
  set(name: string, secret: Secret): Promise<SecretLocation>;
  delete(name: string): Promise<boolean>;
}

const FileContents = z.record(z.string(), z.string());

function noKeychain(err: unknown): boolean {
  return isErrno(err, "ERR_SECRETS_PLATFORM_ERROR");
}

/** OS keychain via `Bun.secrets` (cli-config "Secrets"), entries `<service>/<name>`; a 0600 file where Linux has no keychain [SPIKE-5]. */
export function createSecretStore(opts: {
  os: Os;
  file: string;
  keychain?: KeychainBackend;
  service?: string;
}): SecretStore {
  const keychain = opts.keychain ?? Bun.secrets;
  const service = opts.service ?? "dovet";
  const fallback = opts.os === "linux";

  async function readFileEntries(): Promise<Record<string, string>> {
    try {
      return FileContents.parse(JSON.parse(await readFile(opts.file, "utf8")));
    } catch (err) {
      if (isErrno(err, "ENOENT")) return {};
      throw err;
    }
  }

  async function writeFileEntries(entries: Record<string, string>): Promise<void> {
    const dir = dirname(opts.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const temp = join(dir, `.${basename(opts.file)}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(entries, null, 2), { mode: 0o600 });
      await rename(temp, opts.file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async function fromKeychain<T>(op: () => Promise<T>): Promise<{ value: T } | undefined> {
    try {
      return { value: await op() };
    } catch (err) {
      if (fallback && noKeychain(err)) return undefined;
      throw err;
    }
  }

  return {
    async get(name) {
      const kc = await fromKeychain(() => keychain.get({ service, name }));
      if (kc?.value != null) return { secret: new Secret(kc.value), location: "keychain" };
      if (!fallback) return undefined;
      const value = (await readFileEntries())[name];
      return value === undefined ? undefined : { secret: new Secret(value), location: "file" };
    },

    async set(name, secret) {
      const kc = await fromKeychain(() => keychain.set({ service, name, value: secret.reveal(), persist: "local" }));
      if (kc !== undefined) return "keychain";
      await writeFileEntries({ ...(await readFileEntries()), [name]: secret.reveal() });
      return "file";
    },

    async delete(name) {
      const kc = await fromKeychain(() => keychain.delete({ service, name }));
      if (!fallback) return kc?.value ?? false;
      const entries = await readFileEntries();
      if (!(name in entries)) return kc?.value ?? false;
      const { [name]: _, ...rest } = entries;
      await writeFileEntries(rest);
      return true;
    },
  };
}
