import { login, logout, status } from "./commands/auth.js";
import { deploy } from "./commands/deploy.js";
import { providers } from "./commands/providers.js";
import { agent } from "./commands/agent.js";
import { remember, search, ask, ingest } from "./commands/memory.js";
import { VERSION } from "./version.js";

export { VERSION } from "./version.js";

export interface CliRuntime {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => never | void;
  login: () => Promise<void> | void;
  logout: () => Promise<void> | void;
  status: () => Promise<void> | void;
  deploy: (argv?: string[]) => Promise<void> | void;
  providers: (argv?: string[]) => Promise<void> | void;
  agent: (argv?: string[]) => Promise<void> | void;
  remember: (argv: string[]) => Promise<void> | void;
  search: (argv: string[]) => Promise<void> | void;
  ask: (argv: string[]) => Promise<void> | void;
  ingest: (argv: string[]) => Promise<void> | void;
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
    agent,
    remember,
    search,
    ask,
    ingest,
  };
}
/* v8 ignore stop */

export function printHelp(logger: (message: string) => void = console.log) {
  logger(`
  schift v${VERSION} - AI Agent CLI

  Usage: schift <command>

  Commands:
    auth login     Authenticate with Schift (opens browser)
    auth logout    Remove stored API key
    auth status    Show authentication status
    deploy         Deploy agent to Schift (upload data, create bucket)
    agent call     Call a deployed agent query endpoint
    providers set  Configure org-level LLM provider access

  Second Brain:
    remember "..."   Save a note to your knowledge base
    search "..."     Semantic search your knowledge
    ask "..."        RAG Q&A over your knowledge
    ingest ./path    Bulk ingest local files

  Options:
    --version      Show version
    --help         Show this help
`);
}

export async function runCli(
  args: string[],
  runtime: CliRuntime = defaultRuntime(),
) {
  const command = args[0];
  const subcommand = args[1];

  if (!command || command === "--help" || command === "-h") {
    printHelp(runtime.log);
    return;
  }

  if (command === "--version" || command === "-v") {
    runtime.log(`schift v${VERSION}`);
    return;
  }

  if (command === "auth") {
    if (subcommand === "login") return runtime.login();
    if (subcommand === "logout") return runtime.logout();
    if (subcommand === "status") return runtime.status();
    runtime.log("  Usage: schift auth <login|logout|status>\n");
    return;
  }

  if (command === "deploy") {
    return runtime.deploy(args.slice(1));
  }

  if (command === "providers") {
    return runtime.providers(args.slice(1));
  }

  if (command === "agent") {
    return runtime.agent(args.slice(1));
  }

  if (command === "remember" || command === "rem" || command === "save") {
    return runtime.remember(args.slice(1));
  }

  if (command === "search" || command === "find") {
    return runtime.search(args.slice(1));
  }

  if (command === "ask") {
    return runtime.ask(args.slice(1));
  }

  if (command === "ingest") {
    return runtime.ingest(args.slice(1));
  }

  runtime.error(`  Unknown command: ${command}\n`);
  printHelp(runtime.log);
  runtime.exit(1);
}

export async function main(
  args: string[] = process.argv.slice(2),
  runtime: CliRuntime = defaultRuntime(),
) {
  try {
    await runCli(args, runtime);
  } catch (err) {
    runtime.error(`\n  Error: ${(err as Error).message}\n`);
    runtime.exit(1);
  }
}
