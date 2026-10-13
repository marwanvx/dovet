// `bun run probe [model…]`: which NVIDIA models work today (testing "Free test provider: NVIDIA"); prints, saves nothing.
import { endpointOf, providerRecord } from "../src/ai/index.ts";
import { Secret } from "../src/store/index.ts";
import { probeModel } from "../test/helpers/nvidia-probe.ts";
import { NVIDIA_MODELS } from "../test/helpers/nvidia-scenarios.ts";

const key = process.env.NVIDIA_API_KEY;
if (!key) {
  console.error("probe: NVIDIA_API_KEY is not set (the free key from build.nvidia.com)");
  process.exit(2);
}
const baseURL = endpointOf(providerRecord("nvidia")).baseURL;
const wanted = process.argv.slice(2);
for (const model of wanted.length > 0 ? wanted : NVIDIA_MODELS) {
  const r = await probeModel(model, { baseURL, apiKey: new Secret(key) });
  console.log(
    r.ok ? `ok       ${model} (${r.reasons ? "reasons" : "no reasoning"})` : `skipped  ${model}: ${r.skipped}`,
  );
}
