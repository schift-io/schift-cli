import { getApiKey, getApiUrl } from "../config.js";

interface AgentCallRuntime {
  getApiKey: () => string | null;
  getApiUrl: () => string;
  log: (message: string) => void;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

interface AgentCallOptions {
  agentRef: string;
  query: string;
  topK: number;
  json: boolean;
}

function defaultRuntime(): AgentCallRuntime {
  return {
    getApiKey,
    getApiUrl,
    log: (message) => console.log(message),
    fetch: (input, init) => fetch(input, init),
  };
}

export function parseAgentCallOptions(argv: string[] = []): AgentCallOptions {
  if (argv[0] !== "call") {
    throw new Error(
      'Usage: schift agent call <agent-id-or-slug> "query" [--top-k <n>] [--json]',
    );
  }

  let topK = 5;
  let json = false;
  const positionals: string[] = [];

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--top-k") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --top-k");
      }
      topK = Number.parseInt(value, 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--top-k=")) {
      topK = Number.parseInt(arg.slice("--top-k=".length), 10);
      continue;
    }
    positionals.push(arg);
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error("--top-k must be a positive integer");
  }

  if (positionals.length < 2) {
    throw new Error(
      'Usage: schift agent call <agent-id-or-slug> "query" [--top-k <n>] [--json]',
    );
  }

  const [agentRef, ...queryParts] = positionals;
  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("Query is required");
  }

  return { agentRef, query, topK, json };
}

export async function agentCallWithRuntime(
  argv: string[] = [],
  runtime: AgentCallRuntime = defaultRuntime(),
): Promise<void> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    throw new Error('Not authenticated. Run "schift auth login" first.');
  }

  const options = parseAgentCallOptions(argv);
  const response = await runtime.fetch(
    `${runtime.getApiUrl()}/v1/agents/${encodeURIComponent(options.agentRef)}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "schift-cli/0.1.0",
      },
      body: JSON.stringify({
        query: options.query,
        top_k: options.topK,
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const payload = await response.json();

  if (options.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const answer =
    payload?.answer ??
    payload?.output_text ??
    payload?.response ??
    payload?.message;
  if (typeof answer === "string" && answer.trim()) {
    runtime.log(answer.trim());
    return;
  }

  runtime.log(JSON.stringify(payload, null, 2));
}

export async function agent(argv: string[] = []): Promise<void> {
  return agentCallWithRuntime(argv, defaultRuntime());
}
