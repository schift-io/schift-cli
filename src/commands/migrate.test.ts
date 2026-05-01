import { describe, expect, it, vi } from "vitest";
import {
  parsePlanOptions,
  parseRunOptions,
  planWithRuntime,
  runWithRuntime,
  cardAddWithRuntime,
} from "./migrate.js";

describe("parsePlanOptions", () => {
  it("requires --tokens", () => {
    expect(() => parsePlanOptions([])).toThrow(/Usage:/);
  });

  it("parses --tokens and defaults sla to std", () => {
    const opts = parsePlanOptions(["--tokens", "1000000000"]);
    expect(opts.tokens).toBe(1_000_000_000);
    expect(opts.sla).toBe("std");
    expect(opts.json).toBe(false);
  });

  it("parses --tokens=N inline form", () => {
    const opts = parsePlanOptions(["--tokens=5000000000", "--sla=scale"]);
    expect(opts.tokens).toBe(5_000_000_000);
    expect(opts.sla).toBe("scale");
  });

  it("rejects invalid sla", () => {
    expect(() => parsePlanOptions(["--tokens", "1", "--sla", "bogus"])).toThrow(
      /--sla must be/,
    );
  });

  it("supports --json", () => {
    const opts = parsePlanOptions(["--tokens", "1", "--json"]);
    expect(opts.json).toBe(true);
  });
});

describe("parseRunOptions", () => {
  it("requires --source, --target, --tokens, and connector config", () => {
    expect(() => parseRunOptions([])).toThrow(/--source/);
    expect(() => parseRunOptions(["--source", "pgvector"])).toThrow(/--target/);
    expect(() =>
      parseRunOptions([
        "--source",
        "pgvector",
        "--target",
        "col_x",
      ]),
    ).toThrow(/--tokens/);
    expect(() =>
      parseRunOptions([
        "--source",
        "pgvector",
        "--target",
        "col_x",
        "--tokens",
        "100",
      ]),
    ).toThrow(/connector config/);
  });

  it("parses connector config via --config.<key>=<value>", () => {
    const opts = parseRunOptions([
      "--source",
      "pgvector",
      "--target",
      "col_x",
      "--tokens",
      "5000000000",
      "--sla",
      "scale",
      "--config.dsn=postgresql://u:p@h/d?sslmode=require",
      "--config.table=public.docs",
      "--confirm",
      "227.50",
    ]);
    expect(opts.source).toBe("pgvector");
    expect(opts.targetCollectionId).toBe("col_x");
    expect(opts.nTokens).toBe(5_000_000_000);
    expect(opts.sla).toBe("scale");
    expect(opts.config).toEqual({
      dsn: "postgresql://u:p@h/d?sslmode=require",
      table: "public.docs",
    });
    expect(opts.confirmedPriceUsd).toBeCloseTo(227.5);
  });
});

describe("planWithRuntime", () => {
  it("POSTs n_tokens + sla_tier to /v1/migrate/quote and renders tier", async () => {
    const log = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        tier: "pro_trial",
        trial_plan: "pro",
        trial_months: 1,
        customer_price_usd: 0,
        vendor_full_cost_usd: 260,
        savings_vs_vendor_direct_usd: 260,
        card_required: true,
        contact_sales: false,
        messaging:
          "Migrate to Schift — Pro trial 1 month free, then $350/mo (auto-renew, cancel anytime).",
      }),
    } as unknown as Response));
    const runtime = {
      getApiKey: () => null,
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log,
      error: vi.fn(),
      fetch: fetchMock,
    };

    await planWithRuntime(["--tokens", "2000000000"], runtime);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://migrate.test/v1/migrate/quote",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ n_tokens: 2_000_000_000, sla_tier: "std" }),
      }),
    );
    const printed = log.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("Pro trial");
    expect(printed).toContain("$260");
    expect(printed).toContain("schift card add");
  });

  it("prints contact_sales link for the contact_sales tier", async () => {
    const log = vi.fn();
    const runtime = {
      getApiKey: () => null,
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log,
      error: vi.fn(),
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          tier: "contact_sales",
          customer_price_usd: 0,
          vendor_full_cost_usd: 13000,
          savings_vs_vendor_direct_usd: 0,
          card_required: false,
          contact_sales: true,
          messaging: "Your migration is large — contact sales.",
        }),
      } as unknown as Response)),
    };

    await planWithRuntime(["--tokens", "100000000000"], runtime);
    const printed = log.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("contact sales");
    expect(printed).toContain("https://web.test/contact?topic=enterprise-migration");
  });
});

describe("runWithRuntime", () => {
  it("requires login", async () => {
    const runtime = {
      getApiKey: () => null,
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log: vi.fn(),
      error: vi.fn(),
      fetch: vi.fn(),
    };
    await expect(runWithRuntime([], runtime)).rejects.toThrow(/auth login/);
  });

  it("forwards source + config + tokens to /v1/migrate/start with bearer", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        job_id: "job_abc",
        state: "queued",
        tier: "pro_trial",
        trial_plan: "pro",
        trial_months: 1,
        customer_price_usd: 0,
        card_required: true,
        requires_payment: false,
      }),
    } as unknown as Response));
    const runtime = {
      getApiKey: () => "sk_test_1",
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log: vi.fn(),
      error: vi.fn(),
      fetch: fetchMock,
    };

    await runWithRuntime(
      [
        "--source",
        "pgvector",
        "--target",
        "col_x",
        "--tokens",
        "2000000000",
        "--config.dsn=postgresql://u:p@h/d",
        "--config.table=public.docs",
      ],
      runtime,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://migrate.test/v1/migrate/start");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_1");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.source).toEqual({
      kind: "pgvector",
      config: {
        dsn: "postgresql://u:p@h/d",
        table: "public.docs",
      },
    });
    expect(body.n_tokens).toBe(2_000_000_000);
    expect(body.sla_tier).toBe("std");
  });

  it("surfaces 409 quote-drift hint", async () => {
    const error = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => "Quote drift: client confirmed $1.00 but server quote is $227.50.",
      json: async () => ({}),
    } as unknown as Response));
    const runtime = {
      getApiKey: () => "sk_test_1",
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log: vi.fn(),
      error,
      fetch: fetchMock,
    };

    await expect(
      runWithRuntime(
        [
          "--source",
          "pgvector",
          "--target",
          "col_x",
          "--tokens",
          "5000000000",
          "--config.dsn=x",
          "--confirm",
          "1.00",
        ],
        runtime,
      ),
    ).rejects.toThrow(/start 409/);
    const printed = error.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("schift migrate plan");
  });
});

describe("cardAddWithRuntime", () => {
  it("requires login", async () => {
    const runtime = {
      getApiKey: () => null,
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log: vi.fn(),
      error: vi.fn(),
      fetch: vi.fn(),
    };
    await expect(cardAddWithRuntime([], runtime)).rejects.toThrow(/auth login/);
  });

  it("prints the dashboard URL when authenticated", async () => {
    const log = vi.fn();
    const runtime = {
      getApiKey: () => "sk_test_1",
      getMigrateUrl: () => "https://migrate.test",
      getWebUrl: () => "https://web.test",
      log,
      error: vi.fn(),
      fetch: vi.fn(),
    };
    await cardAddWithRuntime([], runtime);
    const printed = log.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("https://web.test/dashboard/billing?action=add_card");
    expect(printed).toContain("$0 charged");
  });
});
