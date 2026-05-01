import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path, { resolve } from "node:path";
import { getApiKey, getApiUrl } from "../config.js";
import { USER_AGENT } from "../version.js";

interface SchiftConfig {
  name: string;
  template?: string;
  agent?: { name: string; model: string; instructions: string };
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

function loadProjectApiKey(cwd: string): string | null {
  const envLocalPath = resolve(cwd, ".env.local");
  if (!existsSync(envLocalPath)) return null;

  const content = readFileSync(envLocalPath, "utf-8");
  const match = content.match(/^SCHIFT_API_KEY=(.*)$/m);
  return match?.[1]?.trim() || null;
}

function resolveApiKey(runtime: DeployRuntime): string | null {
  return loadProjectApiKey(runtime.cwd) || runtime.getApiKey();
}

const DEFAULT_OPTIONS: DeployOptions = {
  waitForProcessing: true,
  smoke: true,
  json: false,
};

function loadProjectConfig(cwd: string): SchiftConfig {
  const configPath = resolve(cwd, "schift.config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      "schift.config.json not found. Are you in a Schift project directory?",
    );
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function collectDataFiles(dir: string, rootDir: string = realpathSync(dir)): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const linkStat = lstatSync(fullPath);
    if (linkStat.isSymbolicLink()) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectDataFiles(fullPath, rootDir));
    } else if (stat.isFile() && entry !== ".gitkeep") {
      const resolved = realpathSync(fullPath);
      if (resolved === rootDir || resolved.startsWith(`${rootDir}${path.sep}`)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export function __test_collectDataFiles(dir: string): string[] {
  return collectDataFiles(dir);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isTerminalJobStatus(status: string): boolean {
  return [
    "completed",
    "succeeded",
    "done",
    "ready",
    "failed",
    "error",
    "cancelled",
  ].includes(status.toLowerCase());
}

function isSuccessJobStatus(status: string): boolean {
  return ["completed", "succeeded", "done", "ready"].includes(
    status.toLowerCase(),
  );
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
  const apiKey = resolveApiKey(runtime);
  if (!apiKey) {
    throw new Error('Not authenticated. Run "schift auth login" first.');
  }

  const url = `${runtime.getApiUrl()}${apiPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": USER_AGENT,
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(60_000),
  };

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

async function uploadFile(
  runtime: DeployRuntime,
  bucketId: string,
  filePath: string,
): Promise<any> {
  const apiKey = resolveApiKey(runtime);
  if (!apiKey) {
    throw new Error('Not authenticated. Run "schift auth login" first.');
  }

  const fileContent = readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  const blob = new Blob([fileContent]);
  formData.append("files", blob, fileName);

  const resp = await runtime.fetch(
    `${runtime.getApiUrl()}/v1/buckets/${bucketId}/upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: formData,
    },
  );

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

async function waitForJobs(
  runtime: DeployRuntime,
  jobIds: string[],
): Promise<void> {
  const unique = [...new Set(jobIds)];
  const total = unique.length;
  let completed = 0;
  const lastStatus: Record<string, string> = {};
  const fileNames: Record<string, string> = {};
  const errors: string[] = [];

  if (total === 0) return;

  runtime.log(`    Tracking ${total} job${total > 1 ? "s" : ""}...`);

  // Poll all jobs in parallel
  await Promise.all(
    unique.map(async (jobId) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const job = await apiRequest(runtime, "GET", `/v1/jobs/${jobId}`);
        const status = String(job?.status || "unknown");

        // Cache filename from first response
        if (!fileNames[jobId] && job?.file_name) {
          fileNames[jobId] = job.file_name;
        }
        const label = fileNames[jobId] || jobId.slice(0, 8);

        if (status !== lastStatus[jobId]) {
          lastStatus[jobId] = status;
          runtime.log(`    [${completed}/${total}] ${label}: ${status}`);
        }

        if (isTerminalJobStatus(status)) {
          if (isSuccessJobStatus(status)) {
            completed++;
            runtime.log(`    [${completed}/${total}] ${label}: done`);
          } else {
            const errorDetail = job?.error_message
              ? job.error_message.slice(0, 100)
              : status;
            errors.push(`${label}: ${errorDetail}`);
            completed++;
            runtime.log(`    [${completed}/${total}] ${label}: FAILED`);
          }
          return;
        }

        await runtime.sleep(1000);
      }

      errors.push(`${fileNames[jobId] || jobId.slice(0, 8)}: timed out`);
      completed++;
    }),
  );

  if (errors.length > 0) {
    runtime.log(`\n  ${errors.length} job${errors.length > 1 ? "s" : ""} failed:`);
    for (const err of errors) {
      runtime.log(`    - ${err}`);
    }
    throw new Error(`${errors.length} processing job${errors.length > 1 ? "s" : ""} failed`);
  }
}

function progressBar(index: number, total: number): string {
  const width = 10;
  const filled = Math.max(1, Math.round((index / total) * width));
  return `[${"|".repeat(filled)}${" ".repeat(width - filled)}]`;
}

/* v8 ignore start */
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
/* v8 ignore stop */

export async function deployWithRuntime(
  options: DeployOptions,
  runtime: DeployRuntime = defaultRuntime(),
): Promise<void> {
  const config = loadProjectConfig(runtime.cwd);

  if (!resolveApiKey(runtime)) {
    runtime.log('  Error: Not authenticated. Run "schift auth login" first.\n');
    runtime.exit(1);
    return;
  }

  const slug = slugify(config.agent?.name || config.name);

  if (!options.json) {
    runtime.log("\n  Deploying to Schift Cloud...\n");
    runtime.log(`  Project: ${config.name}`);
    runtime.log("\n  Stage 1/6: Ensure Agent/Bucket");
  }

  const agent: {
    agent_id: string;
    slug: string;
    bucket_id: string;
    bucket_name: string;
    endpoint: string;
  } = await apiRequest(runtime, "PUT", `/v1/agents/${slug}`, {
    name: config.agent?.name || config.name,
    description: config.agent?.instructions || "",
  });

  // Register as Managed Agent (new API) for /v1/agents/{id}/runs support
  let managedAgentId: string | null = null;
  try {
    const managedAgent = await apiRequest(runtime, "POST", `/v1/agents`, {
      name: slug,
      model: config.agent?.model || "gemini-2.5-flash-lite",
      instructions: config.agent?.instructions || "",
      rag_config: { bucket_id: agent.bucket_id, top_k: 5 },
    });
    managedAgentId = managedAgent.id;
  } catch (err) {
    // 409 = already exists, fetch existing
    const errMsg = String((err as Error).message || "");
    if (errMsg.includes("409") || errMsg.includes("already exists")) {
      try {
        const agents = await apiRequest(runtime, "GET", `/v1/agents`);
        const existing = (agents as any[]).find((a: any) => a.name === slug);
        if (existing) {
          managedAgentId = existing.id;
          await apiRequest(runtime, "PATCH", `/v1/agents/${existing.id}`, {
            model: config.agent?.model || "gemini-2.5-flash-lite",
            instructions: config.agent?.instructions || "",
            rag_config: { bucket_id: agent.bucket_id, top_k: 5 },
          });
        }
      } catch (innerErr) {
        if (!options.json) {
          runtime.log(
            `  (Managed Agent update skipped: ${(innerErr as Error).message})`,
          );
        }
      }
    }
  }

  if (!options.json && managedAgentId) {
    runtime.log(`  Managed Agent: ${managedAgentId}`);
  }

  const dataDir = config.rag
    ? resolve(runtime.cwd, config.rag.dataDir || "./data")
    : null;
  const files = dataDir ? collectDataFiles(dataDir) : [];
  const allJobIds: string[] = [];

  if (!options.json) {
    runtime.log(`  Agent: ${config.agent?.name || config.name} (${agent.agent_id})`);
    runtime.log(`  Bucket: ${agent.bucket_name}`);
    runtime.log("\n  Stage 2/6: Upload files");
  }

  if (files.length > 0) {
    // Upload all files in parallel
    const CONCURRENCY = 5;
    const uploadResults: any[] = [];

    for (let start = 0; start < files.length; start += CONCURRENCY) {
      const batch = files.slice(start, start + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (file, batchIdx) => {
          const idx = start + batchIdx;
          const fileName = path.basename(file);
          if (!options.json) {
            runtime.log(`    ${progressBar(idx + 1, files.length)} ${fileName}...`);
          }
          const result = await uploadFile(runtime, agent.bucket_id, file);
          return result;
        }),
      );
      uploadResults.push(...results);
    }

    for (const result of uploadResults) {
      allJobIds.push(...extractJobIds(result));
    }

    if (!options.json) {
      runtime.log(`    ${files.length} file${files.length > 1 ? "s" : ""} uploaded`);
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
    runtime.log("\n  Stage 5/6: Smoke test");
  }
  if (options.smoke && managedAgentId) {
    try {
      if (!options.json) {
        runtime.write("  Running agent...");
      }
      const run = await apiRequest(
        runtime,
        "POST",
        `/v1/agents/${managedAgentId}/runs`,
        {
          message: "Briefly describe what you can help with.",
        },
      );
      const runId = run.id;
      // Poll for completion
      for (let i = 0; i < 60; i++) {
        const status = await apiRequest(
          runtime,
          "GET",
          `/v1/agents/${managedAgentId}/runs/${runId}`,
        );
        if (status.status === "success") {
          smokeOk = true;
          if (!options.json) {
            runtime.log(" ok");
            const preview = (status.output_text || "").slice(0, 120);
            runtime.log(
              `  Agent says: "${preview}${preview.length >= 120 ? "..." : ""}"`,
            );
          }
          break;
        }
        if (status.status === "error" || status.status === "timeout") {
          if (!options.json) {
            runtime.log(` failed (${status.error || status.status})`);
          }
          break;
        }
        await runtime.sleep(1000);
      }
      if (!smokeOk && !options.json) {
        runtime.log(" timed out");
      }
    } catch (err) {
      if (!options.json) {
        runtime.log(` failed (${(err as Error).message})`);
      }
    }
  } else if (options.smoke && config.rag) {
    // Fallback: bucket search
    try {
      const smoke = await apiRequest(
        runtime,
        "POST",
        `/v1/buckets/${agent.bucket_id}/search`,
        {
          query: "What documents are in this knowledge base?",
          top_k: 1,
        },
      );
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
    runtime.log("  Smoke test: skipped");
  }

  const apiUrl = runtime.getApiUrl();
  const agentEndpoint = `${apiUrl}${agent.endpoint}`;

  const summary = {
    agentId: agent.agent_id,
    agentName: config.agent?.name || config.name,
    managedAgentId: managedAgentId || undefined,
    bucketId: agent.bucket_id,
    bucketName: agent.bucket_name,
    endpoint: agentEndpoint,
    managedAgentEndpoint: managedAgentId
      ? `${apiUrl}/v1/agents/${managedAgentId}/runs`
      : undefined,
    cliCall: `schift agent call ${agent.agent_id} "What can you help me with?"`,
    webhook: "Configure webhook in Schift dashboard",
    filesUploaded: files.length,
    jobs: allJobIds.length,
    smokeOk,
  };
  const trialEndpoint = `${apiUrl}/v1/trial/chat`;

  if (options.json) {
    runtime.log(JSON.stringify(summary));
    return;
  }

  const displayKey = resolveApiKey(runtime) || "$SCHIFT_API_KEY";

  runtime.log("\n  Stage 6/6: Final usage");
  runtime.log("\n  Deployed successfully!\n");
  runtime.log(`  Agent ID: ${agent.agent_id}`);
  runtime.log(`  Query URL: ${agentEndpoint}`);
  runtime.log("  Webhook URL: Configure webhook in Schift dashboard");
  runtime.log("\n  Try it with curl:");
  runtime.log(
    `  curl -X POST ${agentEndpoint} \\\n    -H "Authorization: Bearer ${displayKey}" \\\n    -H "Content-Type: application/json" \\\n    -d '{"query": "What can you help me with?", "top_k": 5}'\n`,
  );
  runtime.log("  Or with Schift CLI:");
  runtime.log(`  ${summary.cliCall}\n`);
  runtime.log(`  Trial chat now (bucket: ${agent.bucket_name}):`);
  runtime.log(
    `  curl -X POST ${trialEndpoint} \\\n    -H "Authorization: Bearer ${displayKey}" \\\n    -H "Content-Type: application/json" \\\n    -d '{"bucket": "${agent.bucket_name}", "message": "Say hello from Schift in one short sentence."}'\n`,
  );
  if (managedAgentId) {
    const runEndpoint = `${apiUrl}/v1/agents/${managedAgentId}/runs`;
    runtime.log("  Run agent (Managed Agent API):");
    runtime.log(
      `  curl -X POST ${runEndpoint} \\\n    -H "Authorization: Bearer ${displayKey}" \\\n    -H "Content-Type: application/json" \\\n    -d '{"message": "What can you help me with?"}'\n`,
    );
  }
  runtime.log("  Configure BYOK:");
  runtime.log("  schift providers set anthropic");
}

/* v8 ignore start */
export async function deploy(argv: string[] = []): Promise<void> {
  const options = parseDeployOptions(argv);
  return deployWithRuntime(options, defaultRuntime());
}
/* v8 ignore stop */
