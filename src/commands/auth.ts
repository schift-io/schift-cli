import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getApiKey, setApiKey, clearApiKey, getWebUrl, getApiUrl } from "../config.js";

const LOGIN_HOST = "127.0.0.1";

function previewKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 10)}...${key.slice(-4)}` : "***";
}

function buildShellExportHint(key: string): string {
  return `  export SCHIFT_API_KEY=<${previewKey(key)}>\n`;
}

function openBrowserForPlatform(
  platform: NodeJS.Platform,
  url: string,
  runner: (command: string, args: string[]) => void,
) {
  if (platform === "darwin") {
    runner("open", [url]);
    return;
  }
  if (platform === "win32") {
    runner("cmd", ["/c", "start", "", url]);
    return;
  }
  runner("xdg-open", [url]);
}

/* v8 ignore start */
function openBrowser(url: string) {
  openBrowserForPlatform(process.platform, url, (command, args) => {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.error) throw result.error;
    if (typeof result.status === "number" && result.status !== 0) {
      throw new Error(`Failed to open browser: ${command} exited with ${result.status}`);
    }
  });
}
/* v8 ignore stop */

export function __test_openBrowserForPlatform(
  platform: NodeJS.Platform,
  url: string,
  runner: (command: string, args: string[]) => void,
) {
  openBrowserForPlatform(platform, url, runner);
}

export async function __test_findFreePort() {
  return findFreePort();
}

export const __test_loginHost = LOGIN_HOST;

export function __test_buildShellExportHint(key: string) {
  return buildShellExportHint(key);
}

/* v8 ignore start */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, LOGIN_HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Could not find free port"));
      }
    });
  });
}
/* v8 ignore stop */

function saveToEnvLocal(key: string, cwd: string = process.cwd()) {
  const envPath = resolve(cwd, ".env.local");
  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
    if (content.includes("SCHIFT_API_KEY=")) {
      content = content.replace(/^SCHIFT_API_KEY=.*$/m, `SCHIFT_API_KEY=${key}`);
      writeFileSync(envPath, content);
      return;
    }
  }
  const newLine = content.endsWith("\n") || content === "" ? "" : "\n";
  writeFileSync(envPath, content + newLine + `SCHIFT_API_KEY=${key}\n`);
}

interface LoginCallbackResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  action: "resolve" | "reject" | "continue";
  // `code` is a one-time short-lived opaque exchange code. The CLI redeems
  // it for the actual API key via POST /v1/auth/cli/code-exchange so the
  // raw key never touches the URL.
  code?: string;
  errorMessage?: string;
}

function resolveLoginCallback(params: {
  expectedState: string;
  receivedState: string | null;
  code: string | null;
  error: string | null;
  webUrl: string;
}): LoginCallbackResult {
  if (params.error) {
    return {
      statusCode: 200,
      body: `<html><body><h2>Login failed</h2><p>${params.error}</p><p>You can close this window.</p></body></html>`,
      action: "reject",
      errorMessage: params.error,
    };
  }

  if (params.receivedState !== params.expectedState) {
    return {
      statusCode: 400,
      body: "<html><body><h2>State mismatch</h2><p>Please try again.</p></body></html>",
      action: "continue",
    };
  }

  if (!params.code || params.code.length < 16) {
    return {
      statusCode: 400,
      body: "<html><body><h2>Invalid code</h2><p>Please try again.</p></body></html>",
      action: "continue",
    };
  }

  return {
    statusCode: 302,
    headers: {
      Location: `${params.webUrl}/auth/cli?status=success`,
    },
    action: "resolve",
    code: params.code,
  };
}

/* v8 ignore start */
async function redeemCodeForApiKey(code: string): Promise<string> {
  const apiUrl = getApiUrl().replace(/\/$/, "");
  const res = await fetch(`${apiUrl}/v1/auth/cli/code-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    throw new Error(`Code exchange failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { key?: string };
  if (!payload.key || typeof payload.key !== "string") {
    throw new Error("Code exchange response missing API key");
  }
  return payload.key;
}
/* v8 ignore stop */

export function __test_saveToEnvLocal(key: string, cwd: string) {
  saveToEnvLocal(key, cwd);
}

export function __test_resolveLoginCallback(params: {
  expectedState: string;
  receivedState: string | null;
  code: string | null;
  error: string | null;
  webUrl: string;
}) {
  return resolveLoginCallback(params);
}

/* v8 ignore start */
export async function login() {
  const existing = getApiKey();
  if (existing) {
    console.log(
      `\n  Existing key found (${previewKey(existing)}). Re-authenticating will replace it.\n`,
    );
  }

  const state = randomBytes(16).toString("hex");
  const port = await findFreePort();
  const webUrl = getWebUrl();

  // Start local callback server.
  //
  // The browser redirects to /callback?code=<opaque>&state=<state>. We then
  // POST the code to the API to redeem the actual API key — the key never
  // appears in URL-bearing surfaces (browser history, server access logs).
  const apiKey = await new Promise<string>((resolveKey, reject) => {
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error("Login timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const result = resolveLoginCallback({
          expectedState: state,
          receivedState: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
          error: url.searchParams.get("error"),
          webUrl,
        });

        res.writeHead(result.statusCode, {
          "Content-Type": "text/html",
          ...(result.headers || {}),
        });
        res.end(result.body);

        if (result.action === "reject") {
          clearTimeout(timeout);
          server.close();
          reject(new Error(result.errorMessage || "Login failed"));
          return;
        }

        if (result.action === "resolve") {
          clearTimeout(timeout);
          server.close();
          redeemCodeForApiKey(result.code!)
            .then(resolveKey)
            .catch(reject);
        }
        return;
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, LOGIN_HOST, () => {
      const authUrl = `${webUrl}/auth/cli?port=${port}&state=${state}`;
      console.log(`\n  Opening browser for authentication...\n`);
      console.log(`  If the browser doesn't open, visit:\n  ${authUrl}\n`);
      try {
        openBrowser(authUrl);
      } catch {
        // Browser open failed — user can manually visit the URL
      }
    });
  });

  // Save to global config
  setApiKey(apiKey);
  console.log(`  API key saved to ~/.schift/config.json`);

  // Also save to .env.local if we're in a project directory
  const schiftConfig = resolve(process.cwd(), "schift.config.json");
  if (existsSync(schiftConfig)) {
    saveToEnvLocal(apiKey);
    console.log(`  API key saved to .env.local`);
  }

  console.log(`\n  Authenticated successfully (${previewKey(apiKey)})\n`);
  console.log(`  To use with curl, run:`);
  console.log(buildShellExportHint(apiKey));
}
/* v8 ignore stop */

export function logout() {
  if (!getApiKey()) {
    console.log("  No API key stored.\n");
    return;
  }
  clearApiKey();
  console.log("  API key removed.\n");
}

export function status() {
  const envKey = process.env["SCHIFT_API_KEY"];
  const configKey = getApiKey();

  if (envKey) {
    console.log(`  Authenticated via SCHIFT_API_KEY env var (${previewKey(envKey)})\n`);
  } else if (configKey) {
    console.log(`  Authenticated via ~/.schift/config.json (${previewKey(configKey)})\n`);
  } else {
    console.log(
      `  Not authenticated. Run "schift auth login" to get started.\n`,
    );
  }
}
