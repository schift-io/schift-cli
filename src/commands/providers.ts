import { getApiKey, getApiUrl } from "../config.js";

interface ProviderRuntime {
  getApiKey: () => string | null;
  getApiUrl: () => string;
  log: (message: string) => void;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

interface SetProviderInput {
  apiKey: string;
  endpointUrl?: string;
}

function defaultRuntime(): ProviderRuntime {
  return {
    getApiKey,
    getApiUrl,
    log: (message) => console.log(message),
    fetch: (input, init) => fetch(input, init),
  };
}

export async function setProviderWithRuntime(
  provider: string,
  input: SetProviderInput,
  runtime: ProviderRuntime = defaultRuntime(),
): Promise<void> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    throw new Error('Not authenticated. Run "scloud auth login" first.');
  }

  const body: Record<string, string> = { api_key: input.apiKey };
  if (input.endpointUrl) {
    body.endpoint_url = input.endpointUrl;
  }

  const response = await runtime.fetch(`${runtime.getApiUrl()}/v1/providers/${provider}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "scloud-cli/0.1.0",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const payload = await response.json();
  runtime.log(`Configured ${payload.provider} provider access`);
}

export async function providers(argv: string[] = []): Promise<void> {
  const subcommand = argv[0];
  const provider = argv[1];

  if (subcommand !== "set" || !provider) {
    console.log('  Usage: scloud providers set <openai|google|anthropic>\n');
    return;
  }

  const providerApiKey = process.env.SCHIFT_PROVIDER_API_KEY;
  if (!providerApiKey) {
    throw new Error("SCHIFT_PROVIDER_API_KEY is required");
  }

  await setProviderWithRuntime(
    provider,
    {
      apiKey: providerApiKey,
      endpointUrl: process.env.SCHIFT_PROVIDER_ENDPOINT_URL,
    },
    defaultRuntime(),
  );
}
