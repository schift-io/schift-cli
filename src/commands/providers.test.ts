import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setProviderWithRuntime, providers } from "./providers.js";

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

  it("omits endpoint_url when absent", async () => {
    const calls: string[] = [];

    await setProviderWithRuntime(
      "openai",
      { apiKey: "sk-openai-123" },
      {
        getApiKey: () => "sch_test123",
        getApiUrl: () => "https://api.schift.io",
        log: () => undefined,
        fetch: async (_url: string, init?: RequestInit) => {
          calls.push(String(init?.body || ""));
          return new Response(JSON.stringify({ provider: "openai" }), { status: 200 });
        },
      },
    );

    expect(calls[0]).toBe(JSON.stringify({ api_key: "sk-openai-123" }));
  });

  it("throws when org api key is missing", async () => {
    await expect(
      setProviderWithRuntime(
        "anthropic",
        { apiKey: "sk-ant-123" },
        {
          getApiKey: () => null,
          getApiUrl: () => "https://api.schift.io",
          log: () => undefined,
          fetch: async () => new Response("ok", { status: 200 }),
        },
      ),
    ).rejects.toThrow('Not authenticated. Run "scloud auth login" first.');
  });

  it("throws formatted api errors", async () => {
    await expect(
      setProviderWithRuntime(
        "anthropic",
        { apiKey: "sk-ant-123" },
        {
          getApiKey: () => "sch_test123",
          getApiUrl: () => "https://api.schift.io",
          log: () => undefined,
          fetch: async () => new Response("bad request", { status: 400 }),
        },
      ),
    ).rejects.toThrow("API error 400: bad request");
  });
});

describe("providers", () => {
  const originalApiKey = process.env.SCHIFT_PROVIDER_API_KEY;
  const originalEndpoint = process.env.SCHIFT_PROVIDER_ENDPOINT_URL;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  beforeEach(() => {
    delete process.env.SCHIFT_PROVIDER_API_KEY;
    delete process.env.SCHIFT_PROVIDER_ENDPOINT_URL;
    logSpy.mockClear();
  });

  it("prints usage for invalid argv", async () => {
    await providers([]);
    expect(logSpy).toHaveBeenCalledWith('  Usage: scloud providers set <openai|google|anthropic>\n');
  });

  it("throws when SCHIFT_PROVIDER_API_KEY is missing", async () => {
    await expect(providers(["set", "anthropic"])).rejects.toThrow("SCHIFT_PROVIDER_API_KEY is required");
  });

  it("configures provider through public wrapper", async () => {
    process.env.SCHIFT_PROVIDER_API_KEY = "sk-ant-123";
    process.env.SCHIFT_PROVIDER_ENDPOINT_URL = "https://example.com";

    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: String(init?.body || ""),
      });
      return new Response(JSON.stringify({ provider: "anthropic" }), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    await providers(["set", "anthropic"]);

    expect(calls).toEqual([
      {
        url: "https://api.schift.io/v1/providers/anthropic",
        method: "PUT",
        body: JSON.stringify({ api_key: "sk-ant-123", endpoint_url: "https://example.com" }),
      },
    ]);
    expect(logSpy).toHaveBeenCalledWith("Configured anthropic provider access");
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.SCHIFT_PROVIDER_API_KEY;
    else process.env.SCHIFT_PROVIDER_API_KEY = originalApiKey;
    if (originalEndpoint === undefined) delete process.env.SCHIFT_PROVIDER_ENDPOINT_URL;
    else process.env.SCHIFT_PROVIDER_ENDPOINT_URL = originalEndpoint;
    logSpy.mockRestore();
  });
});
