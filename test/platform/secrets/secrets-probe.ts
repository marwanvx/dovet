// Built by secrets.test.ts with Dovet's compile options (SPIKE-5). Run as `probe <credentials-file> <service>`:
// stores, reads and deletes one secret through the real store and prints what happened as JSON.
import type { Os } from "../../../src/platform/index.ts";
import { createSecretStore, Secret } from "../../../src/store/index.ts";

const [file, service] = process.argv.slice(2);
if (file === undefined || service === undefined) throw new Error("usage: probe <credentials-file> <service>");
const store = createSecretStore({ os: process.platform as Os, file, service });
const value = `probe-${crypto.randomUUID()}`;
const location = await store.set("probe", new Secret(value));
const read = await store.get("probe");
const deleted = await store.delete("probe");
const after = await store.get("probe");
console.log(
  JSON.stringify({
    location,
    readBack: read?.secret.reveal() === value,
    readFrom: read?.location,
    deleted,
    gone: after === undefined,
  }),
);
