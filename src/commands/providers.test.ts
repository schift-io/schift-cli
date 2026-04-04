import { describe, it, expect } from "vitest";
import { setProviderWithRuntime } from "./providers.js";


describe("setProviderWithRuntime", () => {
  it("writes provider config through org API", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const logs: string[] = [];

    await setProviderWithRuntime(
      "anthropic",
      {
        apiKey: "sk-ant-123",
        endpointUrl: "https://example.com",
      },
      {
        getApiKey: () => "sch_test123",
        getApiUrl: () => "https://api.schift.io",
        log: (msg: string) => logs.push(msg),
        fetch: async (url: string, init?: RequestInit) => {
          calls.push({
            url,
            method: init?.method,
            body: String(init?.body || ""),
          });
          return new Response(
            JSON.stringify({
              provider: "anthropic",
              configured: true,
              endpoint_url: "https://example.com",
            }),
            { status: 200 },
          );
        },
      },
    );

    expect(calls).toEqual([
      {
        url: "https://api.schift.io/v1/providers/anthropic",
        method: "PUT",
        body: JSON.stringify({ api_key: "sk-ant-123", endpoint_url: "https://example.com" }),
      },
    ]);
    expect(logs.join("\n")).toContain("Configured anthropic provider access");
  });
});
