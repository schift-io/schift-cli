#!/usr/bin/env node
import { login, logout, status } from "./commands/auth.js";
import { deploy } from "./commands/deploy.js";
import { providers } from "./commands/providers.js";

const VERSION = "0.1.0";

function printHelp() {
  console.log(`
  schift v${VERSION} - AI Agent CLI

  Usage: schift <command>

  Commands:
    auth login     Authenticate with Schift Cloud (opens browser)
    auth logout    Remove stored API key
    auth status    Show authentication status
    deploy         Deploy agent to Schift Cloud (upload data, create bucket)
    providers set  Configure org-level LLM provider access

  Options:
    --version      Show version
    --help         Show this help
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(`schift v${VERSION}`);
    return;
  }

  if (command === "auth") {
    if (subcommand === "login") return login();
    if (subcommand === "logout") return logout();
    if (subcommand === "status") return status();
    console.log('  Usage: schift auth <login|logout|status>\n');
    return;
  }

  if (command === "deploy") {
    return deploy(args.slice(1));
  }

  if (command === "providers") {
    return providers(args.slice(1));
  }

  console.error(`  Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
