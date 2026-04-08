import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getApiKey, setApiKey, clearApiKey, getWebUrl } from "../config.js";

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

/* v8 ignore start */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
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
  token?: string;
  errorMessage?: string;
}

function resolveLoginCallback(params: {
  expectedState: string;
  receivedState: string | null;
  token: string | null;
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

  if (!params.token || !params.token.startsWith("sch_")) {
    return {
      statusCode: 400,
      body: "<html><body><h2>Invalid token</h2><p>Please try again.</p></body></html>",
      action: "continue",
    };
  }

  return {
    statusCode: 302,
    headers: {
      Location: `${params.webUrl}/auth/cli?status=success`,
    },
    action: "resolve",
    token: params.token,
  };
}

export function __test_saveToEnvLocal(key: string, cwd: string) {
  saveToEnvLocal(key, cwd);
}

export function __test_resolveLoginCallback(params: {
  expectedState: string;
  receivedState: string | null;
  token: string | null;
  error: string | null;
  webUrl: string;
}) {
  return resolveLoginCallback(params);
}

/* v8 ignore start */
export async function login() {
  const existing = getApiKey();
  if (existing) {
    const preview = existing.slice(0, 10) + "..." + existing.slice(-4);
    console.log(
      `\n  Existing key found (${preview}). Re-authenticating will replace it.\n`,
    );
  }

  const state = randomBytes(16).toString("hex");
  const port = await findFreePort();
  const webUrl = getWebUrl();

  // Start local callback server
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
          token: url.searchParams.get("token"),
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
          resolveKey(result.token!);
        }
        return;
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, () => {
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

  const preview = apiKey.slice(0, 10) + "..." + apiKey.slice(-4);
  console.log(`\n  Authenticated successfully (${preview})\n`);
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
    const preview = envKey.slice(0, 10) + "..." + envKey.slice(-4);
    console.log(`  Authenticated via SCHIFT_API_KEY env var (${preview})\n`);
  } else if (configKey) {
    const preview = configKey.slice(0, 10) + "..." + configKey.slice(-4);
    console.log(`  Authenticated via ~/.schift/config.json (${preview})\n`);
  } else {
    console.log(
      `  Not authenticated. Run "schift auth login" to get started.\n`,
    );
  }
}
