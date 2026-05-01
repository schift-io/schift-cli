import { getApiKey, getMigrateUrl, getWebUrl } from "../config.js";
import { USER_AGENT } from "../version.js";

/* Surface for `schift migrate ...` — talks to schift-migration service.
 *
 * Subcommands:
 *   plan    — POST /v1/migrate/quote (public). No auth. Show tier + savings.
 *   run     — POST /v1/migrate/start (auth). Kicks off the job, returns id.
 *   status  — GET  /v1/migrate/{id}  (auth). Polls the job state.
 *   card    — opens Polar checkout in browser (setup intent — card on file,
 *             no charge until next month's plan billing kicks in).
 */

interface MigrateRuntime {
  getApiKey: () => string | null;
  getMigrateUrl: () => string;
  getWebUrl: () => string;
  log: (message: string) => void;
  error: (message: string) => void;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

function defaultRuntime(): MigrateRuntime {
  return {
    getApiKey,
    getMigrateUrl,
    getWebUrl,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    fetch: (input, init) => fetch(input, init),
  };
}

const SLA_VALUES = new Set(["std", "scale"]);

function fmtUsd(n: number | undefined | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (Math.abs(n) >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

interface PlanOptions {
  tokens: number;
  sla: "std" | "scale";
  json: boolean;
}

export function parsePlanOptions(argv: string[]): PlanOptions {
  let tokens: number | null = null;
  let sla: "std" | "scale" = "std";
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tokens" || arg === "-n") {
      const v = argv[i + 1];
      if (!v) throw new Error("Missing value for --tokens");
      tokens = Number.parseInt(v, 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--tokens=")) {
      tokens = Number.parseInt(arg.slice("--tokens=".length), 10);
      continue;
    }
    if (arg === "--sla") {
      const v = argv[i + 1];
      if (!v) throw new Error("Missing value for --sla");
      if (!SLA_VALUES.has(v)) throw new Error('--sla must be "std" or "scale"');
      sla = v as "std" | "scale";
      i += 1;
      continue;
    }
    if (arg.startsWith("--sla=")) {
      const v = arg.slice("--sla=".length);
      if (!SLA_VALUES.has(v)) throw new Error('--sla must be "std" or "scale"');
      sla = v as "std" | "scale";
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
  }

  if (tokens === null || !Number.isInteger(tokens) || tokens < 0) {
    throw new Error(
      'Usage: schift migrate plan --tokens <N> [--sla std|scale] [--json]',
    );
  }

  return { tokens, sla, json };
}

const TIER_HUMAN: Record<string, string> = {
  starter_trial: "Starter trial — 1 month free, then $59/mo",
  pro_trial: "Pro trial — 1 month free, then $350/mo",
  paid_std: "Paid migration (Standard) + Pro trial bundled (1 month free, then $350/mo)",
  paid_scale: "Paid migration (Scale) + Pro trial bundled (1 month free, then $350/mo)",
  contact_sales: "Enterprise — contact sales",
};

export async function planWithRuntime(
  argv: string[] = [],
  runtime: MigrateRuntime = defaultRuntime(),
): Promise<void> {
  const opts = parsePlanOptions(argv);
  const url = `${runtime.getMigrateUrl()}/v1/migrate/quote`;

  const resp = await runtime.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ n_tokens: opts.tokens, sla_tier: opts.sla }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`/v1/migrate/quote ${resp.status}: ${body.slice(0, 200)}`);
  }
  const q = (await resp.json()) as Record<string, unknown>;

  if (opts.json) {
    runtime.log(JSON.stringify(q, null, 2));
    return;
  }

  const tier = String(q.tier ?? "");
  const vendorCost = q.vendor_full_cost_usd as number | undefined;
  const customerPrice = q.customer_price_usd as number | undefined;
  const savings = q.savings_vs_vendor_direct_usd as number | undefined;
  const messaging = String(q.messaging ?? "");

  runtime.log("");
  runtime.log(`  Migration plan for ${opts.tokens.toLocaleString()} tokens (sla: ${opts.sla})`);
  runtime.log("");
  runtime.log(`  Tier             : ${TIER_HUMAN[tier] ?? tier}`);
  runtime.log(`  Vendor would cost: ${fmtUsd(vendorCost)}  (OpenAI text-embedding-3-large)`);
  runtime.log(`  You pay          : ${fmtUsd(customerPrice)}`);
  if (savings !== undefined) runtime.log(`  Savings          : ${fmtUsd(savings)}`);
  runtime.log("");
  runtime.log(`  ${messaging}`);
  runtime.log("");

  if (q.card_required) {
    runtime.log("  Next: schift card add   (register a card to start the trial)");
    runtime.log("        schift migrate run --source ... --table ...");
  } else if (q.contact_sales) {
    runtime.log(`  Visit ${runtime.getWebUrl()}/contact?topic=enterprise-migration`);
  }
  runtime.log("");
}

export async function plan(argv: string[] = []): Promise<void> {
  await planWithRuntime(argv, defaultRuntime());
}

// ── card ────────────────────────────────────────────────────────────────────

export async function cardAddWithRuntime(
  _argv: string[] = [],
  runtime: MigrateRuntime = defaultRuntime(),
): Promise<void> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    throw new Error("Not logged in. Run: schift auth login");
  }
  // Card-on-file is the same Polar checkout surface as plan signup —
  // setup_intent on the customer's account that doesn't charge until
  // the trial converts. The dashboard already serves it.
  const url = `${runtime.getWebUrl()}/dashboard/billing?action=add_card`;
  runtime.log("");
  runtime.log(`  Open ${url}`);
  runtime.log("  Add a card. Next month's plan invoice will charge it automatically.");
  runtime.log("  Until then: $0 charged.");
  runtime.log("");
}

export async function cardAdd(argv: string[] = []): Promise<void> {
  await cardAddWithRuntime(argv, defaultRuntime());
}

// ── run ─────────────────────────────────────────────────────────────────────

interface RunOptions {
  source: string;
  config: Record<string, unknown>;
  targetCollectionId: string;
  nTokens: number;
  sla: "std" | "scale";
  confirmedPriceUsd?: number;
}

export function parseRunOptions(argv: string[]): RunOptions {
  let source = "";
  const cfg: Record<string, unknown> = {};
  let target = "";
  let nTokens: number | null = null;
  let sla: "std" | "scale" = "std";
  let confirmed: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeVal = (): string => {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return v;
    };
    if (arg === "--source") { source = takeVal(); continue; }
    if (arg === "--target" || arg === "--target-collection") {
      target = takeVal(); continue;
    }
    if (arg === "--tokens" || arg === "-n") {
      nTokens = Number.parseInt(takeVal(), 10);
      continue;
    }
    if (arg === "--sla") {
      const v = takeVal();
      if (!SLA_VALUES.has(v)) throw new Error('--sla must be "std" or "scale"');
      sla = v as "std" | "scale";
      continue;
    }
    if (arg === "--confirm") {
      confirmed = Number.parseFloat(takeVal());
      continue;
    }
    if (arg.startsWith("--config.")) {
      // --config.dsn=postgresql://...   or   --config.table file_chunks
      const rest = arg.slice("--config.".length);
      const eq = rest.indexOf("=");
      if (eq > 0) {
        cfg[rest.slice(0, eq)] = rest.slice(eq + 1);
      } else {
        cfg[rest] = takeVal();
      }
      continue;
    }
  }

  if (!source) throw new Error("--source is required (e.g., pgvector|chroma|pinecone|weaviate)");
  if (!target) throw new Error("--target <collection_id> is required");
  if (nTokens === null) {
    throw new Error("--tokens <N> is required (estimate; server re-quotes)");
  }
  if (Object.keys(cfg).length === 0) {
    throw new Error(
      "Provide source connector config via --config.<key>=<value>, e.g. --config.dsn=postgresql://… --config.table=file_chunks",
    );
  }

  return {
    source,
    config: cfg,
    targetCollectionId: target,
    nTokens,
    sla,
    confirmedPriceUsd: confirmed,
  };
}

export async function runWithRuntime(
  argv: string[] = [],
  runtime: MigrateRuntime = defaultRuntime(),
): Promise<void> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    throw new Error("Not logged in. Run: schift auth login");
  }
  const opts = parseRunOptions(argv);

  const body: Record<string, unknown> = {
    source: { kind: opts.source, config: opts.config },
    target_collection_id: opts.targetCollectionId,
    method: "ridge",
    retain_on_cloud: true,
    n_tokens: opts.nTokens,
    sla_tier: opts.sla,
  };
  if (opts.confirmedPriceUsd !== undefined) {
    body.confirmed_price_usd = opts.confirmedPriceUsd;
  }

  const url = `${runtime.getMigrateUrl()}/v1/migrate/start`;
  const resp = await runtime.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 400 || resp.status === 409) {
    const reason = await resp.text();
    runtime.error("");
    runtime.error(`  ${reason}`);
    runtime.error(
      "  Tip: run `schift migrate plan --tokens N --sla std|scale` first to see the price,",
    );
    runtime.error(
      "       then pass `--confirm <amount>` to migrate run.",
    );
    runtime.error("");
    throw new Error(`/v1/migrate/start ${resp.status}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Not authorized. Check `schift auth status`.");
  }
  if (resp.status === 413) {
    const reason = await resp.text();
    runtime.error(`  ${reason}`);
    runtime.error(`  Visit ${runtime.getWebUrl()}/contact?topic=enterprise-migration`);
    throw new Error("contact sales");
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`/v1/migrate/start ${resp.status}: ${body.slice(0, 200)}`);
  }

  const r = (await resp.json()) as Record<string, unknown>;
  runtime.log("");
  runtime.log(`  Migration job created`);
  runtime.log(`  ----------------------------------------`);
  runtime.log(`  job_id           : ${r.job_id}`);
  runtime.log(`  state            : ${r.state}`);
  runtime.log(`  tier             : ${TIER_HUMAN[String(r.tier)] ?? r.tier}`);
  if (r.trial_plan)
    runtime.log(`  trial            : ${r.trial_plan} (${r.trial_months} month)`);
  if (r.customer_price_usd !== undefined)
    runtime.log(`  one-time charge  : ${fmtUsd(r.customer_price_usd as number)}`);
  if (r.checkout_url)
    runtime.log(`  finish payment   : ${r.checkout_url}`);
  runtime.log("");
  runtime.log(`  Track:  schift migrate status ${r.job_id}`);
  runtime.log("");
}

export async function run(argv: string[] = []): Promise<void> {
  await runWithRuntime(argv, defaultRuntime());
}

// ── status ──────────────────────────────────────────────────────────────────

export async function statusWithRuntime(
  argv: string[] = [],
  runtime: MigrateRuntime = defaultRuntime(),
): Promise<void> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) throw new Error("Not logged in. Run: schift auth login");
  const jobId = argv[0];
  if (!jobId) throw new Error("Usage: schift migrate status <job_id>");

  const url = `${runtime.getMigrateUrl()}/v1/migrate/${encodeURIComponent(jobId)}`;
  const resp = await runtime.fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`/v1/migrate/${jobId} ${resp.status}: ${body.slice(0, 200)}`);
  }
  const j = (await resp.json()) as Record<string, unknown>;
  runtime.log(JSON.stringify(j, null, 2));
}

export async function status(argv: string[] = []): Promise<void> {
  await statusWithRuntime(argv, defaultRuntime());
}

// ── dispatch ────────────────────────────────────────────────────────────────

export function printMigrateHelp(log: (m: string) => void): void {
  log("");
  log("  schift migrate <subcommand>");
  log("");
  log("  Subcommands:");
  log("    plan    Show tier + price for a corpus size");
  log("            schift migrate plan --tokens <N> [--sla std|scale]");
  log("");
  log("    card    Add a card on file (no charge until trial converts)");
  log("            schift migrate card add");
  log("");
  log("    run     Kick off a migration job");
  log("            schift migrate run --source pgvector \\");
  log("              --config.dsn 'postgresql://…' --config.table 'public.docs' \\");
  log("              --target <collection_id> --tokens <N> [--sla std|scale]");
  log("");
  log("    status  Poll a job state");
  log("            schift migrate status <job_id>");
  log("");
}

export async function migrate(argv: string[] = []): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printMigrateHelp((m) => console.log(m));
    return;
  }
  if (sub === "plan") return plan(argv.slice(1));
  if (sub === "card") {
    if (argv[1] === "add") return cardAdd(argv.slice(2));
    console.log("  Usage: schift migrate card add");
    return;
  }
  if (sub === "run") return run(argv.slice(1));
  if (sub === "status") return status(argv.slice(1));
  console.error(`  Unknown migrate subcommand: ${sub}`);
  printMigrateHelp((m) => console.log(m));
  throw new Error("unknown subcommand");
}
