import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path, { resolve } from "node:path";
import { getApiKey, getApiUrl } from "../config.js";

interface SchiftConfig {
  name: string;
  template?: string;
  agent: { name: string; model: string; instructions: string };
  rag?: { bucket: string; dataDir: string };
}

export interface DeployOptions {
  waitForProcessing: boolean;
  smoke: boolean;
  json: boolean;
}

interface DeployRuntime {
  cwd: string;
  getApiKey: () => string | null;
  getApiUrl: () => string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  log: (message: string) => void;
  write: (message: string) => void;
  exit: (code: number) => void;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: DeployOptions = {
  waitForProcessing: true,
  smoke: true,
  json: false,
};

function loadProjectConfig(cwd: string): SchiftConfig {
  const configPath = resolve(cwd, "schift.config.json");
  if (!existsSync(configPath)) {
    throw new Error("schift.config.json not found. Are you in a Schift project directory?");
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function collectDataFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectDataFiles(fullPath));
    } else if (stat.isFile() && entry !== ".gitkeep") {
      files.push(fullPath);
    }
  }
  return files;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isTerminalJobStatus(status: string): boolean {
  return ["completed", "succeeded", "done", "failed", "error", "cancelled"].includes(
    status.toLowerCase(),
  );
}

function isSuccessJobStatus(status: string): boolean {
  return ["completed", "succeeded", "done"].includes(status.toLowerCase());
}

export function parseDeployOptions(argv: string[] = []): DeployOptions {
  const parsed: DeployOptions = { ...DEFAULT_OPTIONS };

  for (const arg of argv) {
    if (arg === "--no-wait") {
      parsed.waitForProcessing = false;
      continue;
    }
    if (arg === "--no-smoke") {
      parsed.smoke = false;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

async function apiRequest(
  runtime: DeployRuntime,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<any> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    throw new Error('Not authenticated. Run "schift auth login" first.');
  }

  const url = `${runtime.getApiUrl()}${apiPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "schift-cli/0.1.0",
  };
  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const resp = await runtime.fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

async function uploadFile(runtime: DeployRuntime, bucketId: string, filePath: string): Promise<any> {
  const apiKey = runtime.getApiKey();
  if (!apiKey) {
    throw new Error('Not authenticated. Run "schift auth login" first.');
  }

  const fileContent = readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  const blob = new Blob([fileContent]);
  formData.append("files", blob, fileName);

  const resp = await runtime.fetch(`${runtime.getApiUrl()}/v1/buckets/${bucketId}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "schift-cli/0.1.0",
    },
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Upload failed for ${fileName}: ${resp.status} ${text}`);
  }

  return resp.json().catch(() => null);
}

function extractJobIds(uploadResult: any): string[] {
  if (!uploadResult || !Array.isArray(uploadResult.jobs)) return [];
  return uploadResult.jobs
    .map((job: any) => String(job?.job_id || "").trim())
    .filter((id: string) => !!id);
}

async function waitForJobs(runtime: DeployRuntime, jobIds: string[]): Promise<void> {
  for (const jobId of jobIds) {
    let lastStatus = "queued";

    for (let attempt = 0; attempt < 120; attempt++) {
      const job = await apiRequest(runtime, "GET", `/v1/jobs/${jobId}`);
      const status = String(job?.status || "unknown");

      if (status !== lastStatus) {
        runtime.log(`    ${jobId}: ${status}`);
        lastStatus = status;
      }

      if (isTerminalJobStatus(status)) {
        if (!isSuccessJobStatus(status)) {
          throw new Error(`Processing failed for ${jobId}: ${status}`);
        }
        break;
      }

      await runtime.sleep(1000);
    }

    if (!isSuccessJobStatus(lastStatus)) {
      throw new Error(`Processing timed out for ${jobId}`);
    }
  }
}

function progressBar(index: number, total: number): string {
  const width = 10;
  const filled = Math.max(1, Math.round((index / total) * width));
  return `[${"|".repeat(filled)}${" ".repeat(width - filled)}]`;
}

function defaultRuntime(): DeployRuntime {
  return {
    cwd: process.cwd(),
    getApiKey,
    getApiUrl,
    fetch: (input, init) => fetch(input, init),
    log: (message) => console.log(message),
    write: (message) => process.stdout.write(message),
    exit: (code) => process.exit(code),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
}

export async function deployWithRuntime(
  options: DeployOptions,
  runtime: DeployRuntime = defaultRuntime(),
): Promise<void> {
  const config = loadProjectConfig(runtime.cwd);

  if (!runtime.getApiKey()) {
    runtime.log('  Error: Not authenticated. Run "schift auth login" first.\n');
    runtime.exit(1);
    return;
  }

  const slug = slugify(config.agent.name || config.name);

  if (!options.json) {
    runtime.log("\n  Deploying to Schift Cloud...\n");
    runtime.log(`  Project: ${config.name}`);
    runtime.log("\n  Stage 1/6: Ensure Agent/Bucket");
  }

  const agent: { agent_id: string; slug: string; bucket_id: string; bucket_name: string; endpoint: string } =
    await apiRequest(runtime, "PUT", `/v1/agents/${slug}`, {
      name: config.agent.name || config.name,
      description: config.agent.instructions || "",
    });

  const dataDir = config.rag ? resolve(runtime.cwd, config.rag.dataDir || "./data") : null;
  const files = dataDir ? collectDataFiles(dataDir) : [];
  const allJobIds: string[] = [];

  if (!options.json) {
    runtime.log(`  Agent: ${config.agent.name} (${agent.agent_id})`);
    runtime.log(`  Bucket: ${agent.bucket_name}`);
    runtime.log("\n  Stage 2/6: Upload files");
  }

  if (files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = path.basename(file);
      if (!options.json) {
        runtime.write(`    ${progressBar(i + 1, files.length)} ${fileName}...`);
      }
      const uploadResult = await uploadFile(runtime, agent.bucket_id, file);
      const jobIds = extractJobIds(uploadResult);
      allJobIds.push(...jobIds);
      if (!options.json) {
        runtime.log(" done");
      }
    }
  } else if (!options.json) {
    runtime.log(`  No data files found in ${config.rag?.dataDir || "./data"}`);
  }

  if (!options.json) {
    runtime.log("\n  Stage 3/6: Processing jobs");
  }
  if (options.waitForProcessing && allJobIds.length > 0) {
    await waitForJobs(runtime, allJobIds);
  } else if (!options.json) {
    runtime.log("    skipped");
  }

  if (!options.json) {
    runtime.log("\n  Stage 4/6: Source provenance");
    runtime.log(`  Source provenance: local files (${files.length})`);
    for (const file of files) {
      runtime.log(`    - ${path.relative(runtime.cwd, file)}`);
    }
  }

  let smokeOk = false;
  if (!options.json) {
    runtime.log("\n  Stage 5/6: Smoke search");
  }
  if (options.smoke && config.rag) {
    try {
      const smoke = await apiRequest(runtime, "POST", `/v1/buckets/${agent.bucket_id}/search`, {
        query: "What documents are in this knowledge base?",
        top_k: 1,
      });
      smokeOk = Array.isArray(smoke?.results);
      if (!options.json) {
        runtime.log(`  Smoke search: ${smokeOk ? "ok" : "no results"}`);
      }
    } catch (err) {
      if (!options.json) {
        runtime.log(`  Smoke search: failed (${(err as Error).message})`);
      }
    }
  } else if (!options.json) {
    runtime.log("  Smoke search: skipped");
  }

  const apiUrl = runtime.getApiUrl();
  const agentEndpoint = `${apiUrl}${agent.endpoint}`;

  const summary = {
    agentId: agent.agent_id,
    agentName: config.agent.name,
    bucketId: agent.bucket_id,
    bucketName: agent.bucket_name,
    endpoint: agentEndpoint,
    webhook: "Configure webhook in Schift dashboard",
    filesUploaded: files.length,
    jobs: allJobIds.length,
    smokeOk,
  };

  if (options.json) {
    runtime.log(JSON.stringify(summary));
    return;
  }

  runtime.log("\n  Stage 6/6: Final usage");
  runtime.log("\n  Deployed successfully!\n");
  runtime.log(`  Agent URL: ${agentEndpoint}`);
  runtime.log("  Webhook URL: Configure webhook in Schift dashboard");
  runtime.log("\n  To use:");
  runtime.log(`  curl -X POST ${agentEndpoint} \\\n    -H \"Authorization: Bearer $SCHIFT_API_KEY\" \\\n    -H \"Content-Type: application/json\" \\\n    -d '{\"query\": \"What can you help me with?\", \"top_k\": 5}'\n`);
}

export async function deploy(argv: string[] = []): Promise<void> {
  const options = parseDeployOptions(argv);
  return deployWithRuntime(options, defaultRuntime());
}
