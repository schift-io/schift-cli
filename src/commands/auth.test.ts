import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __test_buildShellExportHint,
  __test_findFreePort,
  __test_loginHost,
  __test_openBrowserForPlatform,
  __test_resolveLoginCallback,
  __test_saveToEnvLocal,
} from "./auth.js";

describe("openBrowser", () => {
  it("uses argument-safe invocation on macOS", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];

    __test_openBrowserForPlatform(
      "darwin",
      "https://schift.io/auth/cli?x=1&y=2",
      (cmd, args) => {
        calls.push({ cmd, args });
      },
    );

    expect(calls).toEqual([
      {
        cmd: "open",
        args: ["https://schift.io/auth/cli?x=1&y=2"],
      },
    ]);
  });

  it("uses argument-safe invocation on linux", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];

    __test_openBrowserForPlatform(
      "linux",
      "https://schift.io/auth/cli?port=3000",
      (cmd, args) => {
        calls.push({ cmd, args });
      },
    );

    expect(calls).toEqual([
      {
        cmd: "xdg-open",
        args: ["https://schift.io/auth/cli?port=3000"],
      },
    ]);
  });

  it("uses argument-safe invocation on windows", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];

    __test_openBrowserForPlatform(
      "win32",
      "https://schift.io/auth/cli?state=abc",
      (cmd, args) => {
        calls.push({ cmd, args });
      },
    );

    expect(calls).toEqual([
      {
        cmd: "cmd",
        args: ["/c", "start", "", "https://schift.io/auth/cli?state=abc"],
      },
    ]);
  });
});

describe("login helpers", () => {
  it("binds the OAuth callback listener to loopback only", () => {
    expect(__test_loginHost).toBe("127.0.0.1");
  });

  it("finds a free port", async () => {
    const port = await __test_findFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
  });

  it("does not print the full API key in shell export guidance", () => {
    const hint = __test_buildShellExportHint("sch_new123456789012345");

    expect(hint).toContain("sch_new123...2345");
    expect(hint).not.toContain("sch_new123456789012345");
  });

  it("appends SCHIFT_API_KEY to new .env.local", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-auth-save-"));

    __test_saveToEnvLocal("sch_new123456789012345", tmp);

    expect(fs.readFileSync(path.join(tmp, ".env.local"), "utf-8")).toBe(
      "SCHIFT_API_KEY=sch_new123456789012345\n",
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("replaces existing SCHIFT_API_KEY in .env.local", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-auth-save-"));
    fs.writeFileSync(
      path.join(tmp, ".env.local"),
      "FOO=1\nSCHIFT_API_KEY=sch_old\nBAR=2\n",
      "utf-8",
    );

    __test_saveToEnvLocal("sch_new123456789012345", tmp);

    expect(fs.readFileSync(path.join(tmp, ".env.local"), "utf-8")).toBe(
      "FOO=1\nSCHIFT_API_KEY=sch_new123456789012345\nBAR=2\n",
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appends SCHIFT_API_KEY with newline when existing file has no trailing newline", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-auth-save-"));
    fs.writeFileSync(path.join(tmp, ".env.local"), "FOO=1", "utf-8");

    __test_saveToEnvLocal("sch_new123456789012345", tmp);

    expect(fs.readFileSync(path.join(tmp, ".env.local"), "utf-8")).toBe(
      "FOO=1\nSCHIFT_API_KEY=sch_new123456789012345\n",
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns reject result for callback error", () => {
    expect(
      __test_resolveLoginCallback({
        expectedState: "expected",
        receivedState: "expected",
        code: null,
        error: "access_denied",
        webUrl: "https://schift.io",
      }),
    ).toEqual({
      statusCode: 200,
      body: "<html><body><h2>Login failed</h2><p>access_denied</p><p>You can close this window.</p></body></html>",
      action: "reject",
      errorMessage: "access_denied",
    });
  });

  it("returns continue result for state mismatch", () => {
    expect(
      __test_resolveLoginCallback({
        expectedState: "expected",
        receivedState: "other",
        code: "abcdefghijklmnop_validcode",
        error: null,
        webUrl: "https://schift.io",
      }),
    ).toEqual({
      statusCode: 400,
      body: "<html><body><h2>State mismatch</h2><p>Please try again.</p></body></html>",
      action: "continue",
    });
  });

  it("returns continue result for invalid code", () => {
    expect(
      __test_resolveLoginCallback({
        expectedState: "expected",
        receivedState: "expected",
        code: "short",
        error: null,
        webUrl: "https://schift.io",
      }),
    ).toEqual({
      statusCode: 400,
      body: "<html><body><h2>Invalid code</h2><p>Please try again.</p></body></html>",
      action: "continue",
    });
  });

  it("returns redirect result for valid callback", () => {
    expect(
      __test_resolveLoginCallback({
        expectedState: "expected",
        receivedState: "expected",
        code: "abcdefghijklmnop_validcode",
        error: null,
        webUrl: "https://schift.io",
      }),
    ).toEqual({
      statusCode: 302,
      headers: {
        Location: "https://schift.io/auth/cli?status=success",
      },
      action: "resolve",
      code: "abcdefghijklmnop_validcode",
    });
  });
});

describe("status and logout", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const originalEnv = process.env.SCHIFT_API_KEY;
  let tmp: string;

  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schift-auth-test-"));
    process.env.HOME = tmp;
    delete process.env.SCHIFT_API_KEY;
    logSpy.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCHIFT_API_KEY;
    else process.env.SCHIFT_API_KEY = originalEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prints env auth status first", async () => {
    process.env.SCHIFT_API_KEY = "sch_env123456789012345";
    const { status } = await import("./auth.js");
    status();
    expect(logSpy).toHaveBeenCalledWith("  Authenticated via SCHIFT_API_KEY env var (sch_env123...2345)\n");
  });

  it("prints config auth status when config key exists", async () => {
    fs.mkdirSync(path.join(tmp, ".schift"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".schift", "config.json"),
      JSON.stringify({ api_key: "sch_cfg123456789012345" }),
      "utf-8",
    );

    const { status } = await import("./auth.js");
    status();
    expect(logSpy).toHaveBeenCalledWith(
      "  Authenticated via ~/.schift/config.json (sch_cfg123...2345)\n",
    );
  });

  it("prints unauthenticated status when no key exists", async () => {
    const { status } = await import("./auth.js");
    status();
    expect(logSpy).toHaveBeenCalledWith('  Not authenticated. Run "schift auth login" to get started.\n');
  });

  it("logout removes stored key when present", async () => {
    fs.mkdirSync(path.join(tmp, ".schift"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".schift", "config.json"),
      JSON.stringify({ api_key: "sch_cfg123456789012345" }),
      "utf-8",
    );

    const { logout } = await import("./auth.js");
    logout();
    expect(logSpy).toHaveBeenCalledWith("  API key removed.\n");
  });

  it("logout prints no-key message when nothing stored", async () => {
    const { logout } = await import("./auth.js");
    logout();
    expect(logSpy).toHaveBeenCalledWith("  No API key stored.\n");
  });
});
