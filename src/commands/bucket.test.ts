import { describe, it, expect, vi } from "vitest";
import { bucketWithRuntime } from "./bucket.js";

function createRuntime(overrides: Partial<any> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const fetch = vi.fn();

  const runtime = {
    getApiKey: () => "sch_test123456789012345",
    getApiUrl: () => "https://api.schift.io",
    fetch,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
    exit: (code: number) => {
      throw new Error(`EXIT:${code}`);
    },
    ...overrides,
  };

  return { runtime, logs, errors, fetch };
}

describe("bucketWithRuntime", () => {
  it("lists buckets", async () => {
    const { runtime, logs, fetch } = createRuntime();
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: "b1", name: "support-docs", file_count: 3, vector_count: 120 },
          { id: "b2", name: "sales-docs", file_count: 1, vector_count: 20 },
        ]),
        { status: 200 },
      ),
    );

    await bucketWithRuntime(["ls"], runtime);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.schift.io/v1/buckets",
      expect.objectContaining({ method: "GET" }),
    );
    expect(logs.join("\n")).toContain("support-docs");
    expect(logs.join("\n")).toContain("sales-docs");
  });

  it("fails delete without bucket id", async () => {
    const { runtime } = createRuntime();
    await expect(bucketWithRuntime(["rm"], runtime)).rejects.toThrow("EXIT:1");
  });

  it("fails delete without --yes", async () => {
    const { runtime, fetch, errors } = createRuntime();

    await expect(bucketWithRuntime(["rm", "b1"], runtime)).rejects.toThrow("EXIT:1");

    expect(fetch).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--yes");
  });

  it("deletes bucket with --yes", async () => {
    const { runtime, logs, fetch } = createRuntime();
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await bucketWithRuntime(["rm", "b1", "--yes"], runtime);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.schift.io/v1/buckets/b1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(logs.join("\n")).toContain("Deleted bucket b1");
  });

  it("fails when not authenticated", async () => {
    const { runtime } = createRuntime({ getApiKey: () => null });

    await expect(bucketWithRuntime(["ls"], runtime)).rejects.toThrow("EXIT:1");
  });
});
