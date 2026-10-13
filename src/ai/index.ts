// Public surface of the `ai` module (docs/specs/architecture.md "Modules"): The model layer: AI SDK adapter, provider registry, model catalog, pricing, retry policy.
// Other modules import only from this file.
export { PROVIDER_AUTH } from "./providers/auth.ts";
export {
  type AdapterDeps,
  capturingFetch,
  classifyError,
  createSdkAdapter,
  type Endpoint,
  type FetchFunction,
  fromStored,
  sortTools,
  toStored,
} from "./sdk-adapter.ts";
export type {
  EpochHeader,
  ProviderErrorInfo,
  ProviderRequest,
  RawUsage,
  RenderInput,
  SdkCall,
  StopReason,
  StreamEvent,
  ToolDef,
  TranscriptItem,
} from "./types.ts";
