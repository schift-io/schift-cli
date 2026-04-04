import { describe, it, expect } from "vitest";
import { __test_openBrowserForPlatform } from "./auth.js";

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
