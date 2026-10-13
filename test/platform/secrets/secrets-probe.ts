// SPIKE-5 probe, compiled by secrets.test.ts: `probe <credentials-file> <service>` round-trips one secret, prints JSON.
import { createSecretStore, Secret } from "../../../src/store/index.ts";

const [file, service] = process.argv.slice(2);
if (file === undefined || service === undefined) throw new Error("usage: probe <credentials-file> <service>");
const os = process.platform;
if (os !== "linux" && os !== "darwin" && os !== "win32") throw new Error(`unsupported platform ${os}`);
const store = createSecretStore({ os, file, service });
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
