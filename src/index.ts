#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { login, logout, status } from "./commands/auth.js";
import { deploy } from "./commands/deploy.js";
import { providers } from "./commands/providers.js";

export const VERSION = "0.1.0";

export interface CliRuntime {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => never | void;
  login: () => Promise<void> | void;
  logout: () => Promise<void> | void;
  status: () => Promise<void> | void;
  deploy: (argv?: string[]) => Promise<void> | void;
  providers: (argv?: string[]) => Promise<void> | void;
}

/* v8 ignore start */
function defaultRuntime(): CliRuntime {
  return {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
    login,
    logout,
    status,
    deploy,
    providers,
  };
}
/* v8 ignore stop */

export function printHelp(logger: (message: string) => void = console.log) {
  logger(`
  scloud v${VERSION} - AI Agent CLI

  Usage: scloud <command>

  Commands:
    auth login     Authenticate with Scloud (opens browser)
    auth logout    Remove stored API key
    auth status    Show authentication status
    deploy         Deploy agent to Scloud (upload data, create bucket)
    providers set  Configure org-level LLM provider access

  Options:
    --version      Show version
    --help         Show this help
`);
}

export async function runCli(args: string[], runtime: CliRuntime = defaultRuntime()) {
  const command = args[0];
  const subcommand = args[1];

  if (!command || command === "--help" || command === "-h") {
    printHelp(runtime.log);
    return;
  }

  if (command === "--version" || command === "-v") {
    runtime.log(`scloud v${VERSION}`);
    return;
  }

  if (command === "auth") {
    if (subcommand === "login") return runtime.login();
    if (subcommand === "logout") return runtime.logout();
    if (subcommand === "status") return runtime.status();
    runtime.log('  Usage: scloud auth <login|logout|status>\n');
    return;
  }

  if (command === "deploy") {
    return runtime.deploy(args.slice(1));
  }

  if (command === "providers") {
    return runtime.providers(args.slice(1));
  }

  runtime.error(`  Unknown command: ${command}\n`);
  printHelp(runtime.log);
  runtime.exit(1);
}

export async function main(args: string[] = process.argv.slice(2), runtime: CliRuntime = defaultRuntime()) {
  try {
    await runCli(args, runtime);
  } catch (err) {
    runtime.error(`\n  Error: ${(err as Error).message}\n`);
    runtime.exit(1);
  }
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
/* v8 ignore stop */
