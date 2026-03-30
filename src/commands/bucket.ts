import { getApiKey, getApiUrl } from "../config.js";

interface BucketRuntime {
  getApiKey: () => string | null;
  getApiUrl: () => string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
}

interface BucketItem {
  id: string;
  name: string;
  file_count?: number;
  vector_count?: number;
}

function defaultRuntime(): BucketRuntime {
  return {
    getApiKey,
    getApiUrl,
    fetch: (input, init) => fetch(input, init),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
  };
}

function getAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "schift-cli/0.1.0",
  };
}

async function listBuckets(runtime: BucketRuntime): Promise<void> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    runtime.error('  Not authenticated. Run "schift auth login" first.\n');
    runtime.exit(1);
    return;
  }

  const resp = await runtime.fetch(`${runtime.getApiUrl()}/v1/buckets`, {
    method: "GET",
    headers: getAuthHeaders(apiKey),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    runtime.error(`  Error: API error ${resp.status}: ${text}\n`);
    runtime.exit(1);
    return;
  }

  const buckets = (await resp.json()) as BucketItem[];
  if (!Array.isArray(buckets) || buckets.length === 0) {
    runtime.log("  No buckets found.\n");
    return;
  }

  runtime.log("\n  Buckets:");
  for (const b of buckets) {
    runtime.log(
      `  - ${b.id}  ${b.name}  (files: ${b.file_count ?? 0}, vectors: ${b.vector_count ?? 0})`,
    );
  }
  runtime.log("");
}

async function deleteBucket(bucketId: string, yes: boolean, runtime: BucketRuntime): Promise<void> {
  if (!bucketId) {
    runtime.error("  Usage: schift bucket rm <bucket-id> --yes\n");
    runtime.exit(1);
    return;
  }

  if (!yes) {
    runtime.error("  Refusing to delete without --yes.\n");
    runtime.exit(1);
    return;
  }

  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    runtime.error('  Not authenticated. Run "schift auth login" first.\n');
    runtime.exit(1);
    return;
  }

  const resp = await runtime.fetch(`${runtime.getApiUrl()}/v1/buckets/${bucketId}`, {
    method: "DELETE",
    headers: getAuthHeaders(apiKey),
  });

  if (resp.status === 404) {
    runtime.error(`  Bucket not found: ${bucketId}\n`);
    runtime.exit(1);
    return;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    runtime.error(`  Error: API error ${resp.status}: ${text}\n`);
    runtime.exit(1);
    return;
  }

  runtime.log(`  Deleted bucket ${bucketId}\n`);
}

export async function bucketWithRuntime(argv: string[], runtime: BucketRuntime): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === "ls" || sub === "list") {
    await listBuckets(runtime);
    return;
  }

  if (sub === "rm" || sub === "delete") {
    const bucketId = argv[1] || "";
    const yes = argv.includes("--yes");
    await deleteBucket(bucketId, yes, runtime);
    return;
  }

  runtime.error("  Usage: schift bucket <ls|rm>\n");
  runtime.exit(1);
}

export async function bucket(argv: string[] = []): Promise<void> {
  return bucketWithRuntime(argv, defaultRuntime());
}
