import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deployWithRuntime, parseDeployOptions } from "./deploy.js";

describe("parseDeployOptions", () => {
  it("parses defaults", () => {
    expect(parseDeployOptions([])).toEqual({
      waitForProcessing: true,
      smoke: true,
      json: false,
    });
  });

  it("parses no-wait/no-smoke/json flags", () => {
    expect(parseDeployOptions(["--no-wait", "--no-smoke", "--json"])).toEqual({
      waitForProcessing: false,
      smoke: false,
      json: true,
    });
  });

  it("throws for unknown flag", () => {
    expect(() => parseDeployOptions(["--wat"])).toThrow("Unknown option");
  });
});

describe("deployWithRuntime", () => {
  it("runs staged deploy flow and prints final usage", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-deploy-test-"));
    fs.writeFileSync(
      path.join(tmp, "schift.config.json"),
      JSON.stringify(
        {
          name: "support-bot",
          template: "cs-chatbot",
          agent: {
            name: "support-bot",
            model: "gpt-4o-mini",
            instructions: "helpful",
          },
          rag: {
            bucket: "support-bot-docs",
            dataDir: "./data",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "faq.md"), "hello", "utf-8");

    const logs: string[] = [];
    const writes: string[] = [];
    const fetchCalls: string[] = [];
    let jobPollCount = 0;

    const runtime = {
      cwd: tmp,
      getApiKey: () => "sch_test123456789012345",
      getApiUrl: () => "https://api.schift.io",
      log: (msg: string) => logs.push(msg),
      write: (msg: string) => writes.push(msg),
      exit: (code: number) => {
        throw new Error(`EXIT:${code}`);
      },
      sleep: async () => undefined,
      fetch: async (url: string, init?: RequestInit) => {
        fetchCalls.push(`${init?.method || "GET"} ${url}`);

        if (url.endsWith("/v1/agents/support-bot") && init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              agent_id: "a1",
              slug: "support-bot",
              bucket_id: "b1",
              bucket_name: "support-bot-docs",
              endpoint: "/v1/agents/support-bot/query",
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/buckets/b1/upload") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              jobs: [{ job_id: "j1", file_name: "faq.md", status: "queued" }],
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/jobs/j1") && init?.method === "GET") {
          jobPollCount += 1;
          const status = jobPollCount === 1 ? "processing" : "completed";
          return new Response(
            JSON.stringify({
              job_id: "j1",
              file_name: "faq.md",
              status,
              chunks_count: 5,
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/buckets/b1/search") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ results: [{ id: "n1", score: 0.99 }] }),
            { status: 200 },
          );
        }

        return new Response("not found", { status: 404 });
      },
    };

    await deployWithRuntime(
      {
        waitForProcessing: true,
        smoke: true,
        json: false,
      },
      runtime,
    );

    const output = [...logs, ...writes].join("\n");
    expect(output).toContain("Stage 1/6");
    expect(output).toContain("Stage 2/6");
    expect(output).toContain("Stage 3/6");
    expect(output).toContain("Stage 4/6");
    expect(output).toContain("Stage 5/6");
    expect(output).toContain("Stage 6/6");
    expect(output).toContain("Source provenance");
    expect(output).toContain("Webhook URL");
    expect(output).toContain("Search now");
    expect(output).toContain("Trial chat now");
    expect(output).toContain("support-bot-docs");
    expect(output).toContain("/v1/trial/chat");
    expect(output).toContain("Configure BYOK");
    expect(output).toContain("schift providers set anthropic");

    expect(fetchCalls.some((c) => c.includes("GET https://api.schift.io/v1/jobs/j1"))).toBe(true);
    expect(fetchCalls.some((c) => c.includes("POST https://api.schift.io/v1/buckets/b1/search"))).toBe(true);
  });

  it("prints stable JSON schema with --json", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-deploy-test-"));
    fs.writeFileSync(
      path.join(tmp, "schift.config.json"),
      JSON.stringify(
        {
          name: "support-bot",
          template: "cs-chatbot",
          agent: {
            name: "support-bot",
            model: "gpt-4o-mini",
            instructions: "helpful",
          },
          rag: {
            bucket: "support-bot-docs",
            dataDir: "./data",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "faq.md"), "hello", "utf-8");

    const logs: string[] = [];

    const runtime = {
      cwd: tmp,
      getApiKey: () => "sch_test123456789012345",
      getApiUrl: () => "https://api.schift.io",
      log: (msg: string) => logs.push(msg),
      write: () => undefined,
      exit: (code: number) => {
        throw new Error(`EXIT:${code}`);
      },
      sleep: async () => undefined,
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/agents/support-bot") && init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              agent_id: "a1",
              slug: "support-bot",
              bucket_id: "b1",
              bucket_name: "support-bot-docs",
              endpoint: "/v1/agents/support-bot/query",
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/buckets/b1/upload") && init?.method === "POST") {
          return new Response(JSON.stringify({ jobs: [{ job_id: "j1" }] }), { status: 200 });
        }

        return new Response("not found", { status: 404 });
      },
    };

    await deployWithRuntime(
      {
        waitForProcessing: false,
        smoke: false,
        json: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toEqual({
      agentId: "a1",
      agentName: "support-bot",
      bucketId: "b1",
      bucketName: "support-bot-docs",
      endpoint: "https://api.schift.io/v1/agents/support-bot/query",
      webhook: "Configure webhook in Schift dashboard",
      filesUploaded: 1,
      jobs: 1,
      smokeOk: false,
    });
  });

  it("skips job wait and smoke when flags are disabled", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-deploy-test-"));
    fs.writeFileSync(
      path.join(tmp, "schift.config.json"),
      JSON.stringify(
        {
          name: "support-bot",
          template: "cs-chatbot",
          agent: {
            name: "support-bot",
            model: "gpt-4o-mini",
            instructions: "helpful",
          },
          rag: {
            bucket: "support-bot-docs",
            dataDir: "./data",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "faq.md"), "hello", "utf-8");

    const fetchCalls: string[] = [];

    const runtime = {
      cwd: tmp,
      getApiKey: () => "sch_test123456789012345",
      getApiUrl: () => "https://api.schift.io",
      log: () => undefined,
      write: () => undefined,
      exit: (code: number) => {
        throw new Error(`EXIT:${code}`);
      },
      sleep: async () => undefined,
      fetch: async (url: string, init?: RequestInit) => {
        fetchCalls.push(`${init?.method || "GET"} ${url}`);

        if (url.endsWith("/v1/agents/support-bot") && init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              agent_id: "a1",
              slug: "support-bot",
              bucket_id: "b1",
              bucket_name: "support-bot-docs",
              endpoint: "/v1/agents/support-bot/query",
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/buckets/b1/upload") && init?.method === "POST") {
          return new Response(JSON.stringify({ jobs: [{ job_id: "j1" }] }), { status: 200 });
        }

        return new Response("not found", { status: 404 });
      },
    };

    await deployWithRuntime(
      {
        waitForProcessing: false,
        smoke: false,
        json: false,
      },
      runtime,
    );

    expect(fetchCalls.some((c) => c.includes("/v1/jobs/j1"))).toBe(false);
    expect(fetchCalls.some((c) => c.includes("/v1/buckets/b1/search"))).toBe(false);
  });

  it("uses SCHIFT_API_KEY from project .env.local when runtime key is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-deploy-test-"));
    fs.writeFileSync(
      path.join(tmp, "schift.config.json"),
      JSON.stringify(
        {
          name: "support-bot",
          template: "cs-chatbot",
          agent: {
            name: "support-bot",
            model: "gpt-4o-mini",
            instructions: "helpful",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(path.join(tmp, ".env.local"), "SCHIFT_API_KEY=sch_from_env_local\n", "utf-8");

    const authHeaders: string[] = [];

    const runtime = {
      cwd: tmp,
      getApiKey: () => null,
      getApiUrl: () => "https://api.schift.io",
      log: () => undefined,
      write: () => undefined,
      exit: (code: number) => {
        throw new Error(`EXIT:${code}`);
      },
      sleep: async () => undefined,
      fetch: async (_url: string, init?: RequestInit) => {
        authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization || ""));
        return new Response(
          JSON.stringify({
            agent_id: "a1",
            slug: "support-bot",
            bucket_id: "b1",
            bucket_name: "support-bot-docs",
            endpoint: "/v1/agents/support-bot/query",
          }),
          { status: 200 },
        );
      },
    };

    await deployWithRuntime(
      {
        waitForProcessing: false,
        smoke: false,
        json: true,
      },
      runtime,
    );

    expect(authHeaders).toContain("Bearer sch_from_env_local");
  });

  it("prefers project .env.local over runtime key", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-deploy-test-"));
    fs.writeFileSync(
      path.join(tmp, "schift.config.json"),
      JSON.stringify(
        {
          name: "support-bot",
          template: "cs-chatbot",
          agent: {
            name: "support-bot",
            model: "gpt-4o-mini",
            instructions: "helpful",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(path.join(tmp, ".env.local"), "SCHIFT_API_KEY=sch_from_env_local\n", "utf-8");

    const authHeaders: string[] = [];

    const runtime = {
      cwd: tmp,
      getApiKey: () => "sch_from_runtime",
      getApiUrl: () => "https://api.schift.io",
      log: () => undefined,
      write: () => undefined,
      exit: (code: number) => {
        throw new Error(`EXIT:${code}`);
      },
      sleep: async () => undefined,
      fetch: async (_url: string, init?: RequestInit) => {
        authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization || ""));
        return new Response(
          JSON.stringify({
            agent_id: "a1",
            slug: "support-bot",
            bucket_id: "b1",
            bucket_name: "support-bot-docs",
            endpoint: "/v1/agents/support-bot/query",
          }),
          { status: 200 },
        );
      },
    };

    await deployWithRuntime(
      {
        waitForProcessing: false,
        smoke: false,
        json: true,
      },
      runtime,
    );

    expect(authHeaders).toContain("Bearer sch_from_env_local");
    expect(authHeaders).not.toContain("Bearer sch_from_runtime");
  });
});
