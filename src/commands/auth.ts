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

function openBrowser(url: string) {
  openBrowserForPlatform(process.platform, url, (command, args) => {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.error) throw result.error;
    if (typeof result.status === "number" && result.status !== 0) {
      throw new Error(`Failed to open browser: ${command} exited with ${result.status}`);
    }
  });
}

export function __test_openBrowserForPlatform(
  platform: NodeJS.Platform,
  url: string,
  runner: (command: string, args: string[]) => void,
) {
  openBrowserForPlatform(platform, url, runner);
}

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

function saveToEnvLocal(key: string) {
  const envPath = resolve(process.cwd(), ".env.local");
  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
    // Replace existing SCHIFT_API_KEY line
    if (content.includes("SCHIFT_API_KEY=")) {
      content = content.replace(
        /^SCHIFT_API_KEY=.*$/m,
        `SCHIFT_API_KEY=${key}`,
      );
      writeFileSync(envPath, content);
      return;
    }
  }
  // Append
  const newLine = content.endsWith("\n") || content === "" ? "" : "\n";
  writeFileSync(envPath, content + newLine + `SCHIFT_API_KEY=${key}\n`);
}

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
        const receivedState = url.searchParams.get("state");
        const token = url.searchParams.get("token");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h2>Login failed</h2><p>${error}</p><p>You can close this window.</p></body></html>`,
          );
          clearTimeout(timeout);
          server.close();
          reject(new Error(error));
          return;
        }

        if (receivedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>State mismatch</h2><p>Please try again.</p></body></html>",
          );
          return;
        }

        if (!token || !token.startsWith("sch_")) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Invalid token</h2><p>Please try again.</p></body></html>",
          );
          return;
        }

        // Redirect browser back to schift.io (avoids leaving user on localhost)
        const returnUrl = `${webUrl}/auth/cli?status=success`;
        res.writeHead(302, { Location: returnUrl });
        res.end();
        clearTimeout(timeout);
        server.close();
        resolveKey(token);
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
