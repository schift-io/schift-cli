import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CONFIG_DIR = resolve(homedir(), ".schift");
const CONFIG_FILE = resolve(CONFIG_DIR, "config.json");

export const ENV_API_KEY = "SCHIFT_API_KEY";
export const ENV_API_URL = "SCHIFT_API_URL";
export const DEFAULT_API_URL = "https://api.schift.io";
export const DEFAULT_WEB_URL = "https://schift.io";

interface Config {
  api_key?: string;
  api_url?: string;
  [key: string]: unknown;
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(config: Config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o600);
}

export function getApiKey(): string | null {
  return process.env[ENV_API_KEY] || loadConfig().api_key || null;
}

export function setApiKey(key: string) {
  const config = loadConfig();
  config.api_key = key;
  saveConfig(config);
}

export function clearApiKey() {
  const config = loadConfig();
  delete config.api_key;
  saveConfig(config);
}

export function getApiUrl(): string {
  return process.env[ENV_API_URL] || loadConfig().api_url || DEFAULT_API_URL;
}

export function getWebUrl(): string {
  return process.env["SCHIFT_WEB_URL"] || DEFAULT_WEB_URL;
}
