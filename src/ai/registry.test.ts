import { describe, expect, test } from "bun:test";
import { endpointOf, PROVIDER_AUTH, parseRecords, providerRecord } from "./registry.ts";

describe("provider registry", () => {
  test("the nvidia record is Chat Completions at NVIDIA's endpoint with NVIDIA_API_KEY", () => {
    const record = providerRecord("nvidia");
    expect(endpointOf(record)).toMatchObject({
      package: "@ai-sdk/openai-compatible",
      baseURL: "https://integrate.api.nvidia.com/v1",
      quirks: { effortField: "reasoning_effort", reasoningReplay: "in-tool-loop" },
      effortLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(PROVIDER_AUTH.nvidia).toEqual({ id: "nvidia", envVars: ["NVIDIA_API_KEY"] });
  });

  test("an unknown provider is an error naming it", () => {
    expect(() => providerRecord("example")).toThrow('no provider record "example"');
  });

  test("a record with a bad field is refused with the field's path", () => {
    const bad = [
      { ...providerRecord("nvidia"), endpoints: [{ ...providerRecord("nvidia").endpoints[0], baseUrl: 3 }] },
    ];
    expect(() => parseRecords(bad)).toThrow("endpoints.0.baseUrl");
  });

  test("a misspelled field is refused, not ignored", () => {
    expect(() => parseRecords([{ ...providerRecord("nvidia"), envVar: "X" }])).toThrow("envVar");
  });
});
