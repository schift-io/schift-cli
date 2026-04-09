import { describe, it, expect, vi } from "vitest";
import { printHelp, runCli, main, VERSION, type CliRuntime } from "./index.js";

function createRuntime(): CliRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`EXIT:${code}`);
    }),
    login: vi.fn(),
    logout: vi.fn(),
    status: vi.fn(),
    deploy: vi.fn(),
    providers: vi.fn(),
    agent: vi.fn(),
    remember: vi.fn(),
    search: vi.fn(),
    ask: vi.fn(),
    ingest: vi.fn(),
  };
}

describe("printHelp", () => {
  it("prints schift help text", () => {
    const logs: string[] = [];
    printHelp((msg) => logs.push(msg));

    expect(logs[0]).toContain(`schift v${VERSION}`);
    expect(logs[0]).toContain("Usage: schift <command>");
    expect(logs[0]).toContain("auth login");
    expect(logs[0]).toContain("providers set");
    expect(logs[0]).toContain("agent call");
  });
});

describe("runCli", () => {
  it("prints help for no args and help aliases", async () => {
    const runtime = createRuntime();
    await runCli([], runtime);
    await runCli(["--help"], runtime);
    await runCli(["-h"], runtime);

    expect(runtime.log).toHaveBeenCalled();
    expect(runtime.login).not.toHaveBeenCalled();
  });

  it("prints version for long and short flags", async () => {
    const runtime = createRuntime();
    await runCli(["--version"], runtime);
    await runCli(["-v"], runtime);

    expect(runtime.log).toHaveBeenCalledWith(`schift v${VERSION}`);
    expect(runtime.log).toHaveBeenCalledTimes(2);
  });

  it("dispatches auth subcommands", async () => {
    const runtime = createRuntime();

    await runCli(["auth", "login"], runtime);
    await runCli(["auth", "logout"], runtime);
    await runCli(["auth", "status"], runtime);

    expect(runtime.login).toHaveBeenCalledTimes(1);
    expect(runtime.logout).toHaveBeenCalledTimes(1);
    expect(runtime.status).toHaveBeenCalledTimes(1);
  });

  it("prints auth usage for invalid auth subcommand", async () => {
    const runtime = createRuntime();
    await runCli(["auth", "wat"], runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      "  Usage: schift auth <login|logout|status>\n",
    );
  });

  it("dispatches deploy, providers, and agent with sliced args", async () => {
    const runtime = createRuntime();

    await runCli(["deploy", "--json"], runtime);
    await runCli(["providers", "set", "anthropic"], runtime);
    await runCli(["agent", "call", "a1", "hello"], runtime);

    expect(runtime.deploy).toHaveBeenCalledWith(["--json"]);
    expect(runtime.providers).toHaveBeenCalledWith(["set", "anthropic"]);
    expect(runtime.agent).toHaveBeenCalledWith(["call", "a1", "hello"]);
  });

  it("prints unknown command, help, and exits 1", async () => {
    const runtime = createRuntime();

    await expect(runCli(["wat"], runtime)).rejects.toThrow("EXIT:1");
    expect(runtime.error).toHaveBeenCalledWith("  Unknown command: wat\n");
    expect(runtime.log).toHaveBeenCalled();
  });
});

describe("main", () => {
  it("handles default argv path with provided runtime", async () => {
    const runtime = createRuntime();
    await main(undefined, runtime);
    expect(runtime.log).toHaveBeenCalled();
  });

  it("prints formatted error and exits 1 on thrown command error", async () => {
    const runtime: CliRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`EXIT:${code}`);
      }),
      login: vi.fn(),
      logout: vi.fn(),
      status: vi.fn(),
      deploy: vi.fn(async () => {
        throw new Error("boom");
      }),
      providers: vi.fn(),
      agent: vi.fn(),
      remember: vi.fn(),
      search: vi.fn(),
      ask: vi.fn(),
      ingest: vi.fn(),
    };

    await expect(main(["deploy"], runtime)).rejects.toThrow("EXIT:1");
    expect(runtime.error).toHaveBeenCalledWith("\n  Error: boom\n");
  });
});
