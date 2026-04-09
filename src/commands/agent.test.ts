import { describe, expect, it, vi } from "vitest";
import { agentCallWithRuntime, parseAgentCallOptions } from "./agent.js";

describe("parseAgentCallOptions", () => {
  it("parses required args and defaults", () => {
    expect(
      parseAgentCallOptions(["call", "support-bot", "refund policy"]),
    ).toEqual({
      agentRef: "support-bot",
      query: "refund policy",
      topK: 5,
      json: false,
    });
  });

  it("parses --top-k and --json", () => {
    expect(
      parseAgentCallOptions([
        "call",
        "ag_123",
        "refund",
        "policy",
        "--top-k",
        "8",
        "--json",
      ]),
    ).toEqual({
      agentRef: "ag_123",
      query: "refund policy",
      topK: 8,
      json: true,
    });
  });

  it("throws for invalid shape", () => {
    expect(() => parseAgentCallOptions(["wat"])).toThrow(
      "Usage: schift agent call",
    );
    expect(() => parseAgentCallOptions(["call", "ag_123"])).toThrow(
      "Usage: schift agent call",
    );
    expect(() =>
      parseAgentCallOptions(["call", "ag_123", "hello", "--top-k", "0"]),
    ).toThrow("--top-k must be a positive integer");
  });
});

describe("agentCallWithRuntime", () => {
  it("calls /v1/agents/{id}/query and prints answer text", async () => {
    const log = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ answer: "Refunds are available within 30 days." }),
          { status: 200 },
        ),
      );

    await agentCallWithRuntime(["call", "support-bot", "refund policy"], {
      getApiKey: () => "sch_test123456789012345",
      getApiUrl: () => "https://api.schift.io",
      log,
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.schift.io/v1/agents/support-bot/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sch_test123456789012345",
        }),
      }),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      query: "refund policy",
      top_k: 5,
    });
    expect(log).toHaveBeenCalledWith("Refunds are available within 30 days.");
  });

  it("prints JSON payload with --json", async () => {
    const log = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [{ id: "n1" }] }), {
          status: 200,
        }),
      );

    await agentCallWithRuntime(["call", "ag_123", "refund policy", "--json"], {
      getApiKey: () => "sch_test123456789012345",
      getApiUrl: () => "https://api.schift.io",
      log,
      fetch,
    });

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ results: [{ id: "n1" }] }, null, 2),
    );
  });

  it("throws auth hint when key is missing", async () => {
    await expect(
      agentCallWithRuntime(["call", "ag_123", "refund policy"], {
        getApiKey: () => null,
        getApiUrl: () => "https://api.schift.io",
        log: () => undefined,
        fetch: vi.fn(),
      }),
    ).rejects.toThrow('Not authenticated. Run "schift auth login" first.');
  });
});
