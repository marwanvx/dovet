// Public surface of the `ai` module (docs/specs/architecture.md "Modules"): The model layer: AI SDK adapter, provider registry, model catalog, pricing, retry policy.
// Other modules import only from this file.
export {
  BILLED_REFUSAL_CATEGORIES,
  type Cost,
  type CostInput,
  computeCost,
  formatCost,
  LOCAL_PRICE,
  type ModelPrice,
  type ModelRates,
  type PriceRates,
  type PricingRule,
  pricingRule,
  type TokenTotals,
} from "./cost.ts";
export { endpointOf, imageSupport, PROVIDER_AUTH, pdfSupport, providerRecord } from "./registry.ts";
export {
  type CallEvent,
  CONTINUE_AFTER_DROP,
  callModel,
  MAX_ATTEMPTS,
  NOT_RUN_AFTER_DROP,
  type RetryDeps,
  STREAM_IDLE_TIMEOUT_MS,
  timedFetch,
} from "./retry.ts";
export {
  type AdapterDeps,
  capturingFetch,
  classifyError,
  createSdkAdapter,
  type Endpoint,
  type FetchFunction,
  fromStored,
  instructionDelivery,
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
