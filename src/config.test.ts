import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockChmodSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  chmodSync: mockChmodSync,
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
}));

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.SCHIFT_API_KEY;
    delete process.env.SCHIFT_API_URL;
    delete process.env.SCHIFT_WEB_URL;
  });

  it("returns empty config when file is missing or invalid", async () => {
    mockExistsSync.mockReturnValueOnce(false);
    const configA = await import("./config.js");
    expect(configA.loadConfig()).toEqual({});

    vi.resetModules();
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce("not-json");
    const configB = await import("./config.js");
    expect(configB.loadConfig()).toEqual({});
  });

  it("prefers env vars over config values", async () => {
    process.env.SCHIFT_API_KEY = "sch_env123456789012345";
    process.env.SCHIFT_API_URL = "https://env.api";
    process.env.SCHIFT_WEB_URL = "https://env.web";
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      api_key: "sch_cfg123456789012345",
      api_url: "https://cfg.api",
    }));

    const config = await import("./config.js");
    expect(config.getApiKey()).toBe("sch_env123456789012345");
    expect(config.getApiUrl()).toBe("https://env.api");
    expect(config.getWebUrl()).toBe("https://env.web");
  });

  it("uses config and defaults when env vars are absent", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      api_key: "sch_cfg123456789012345",
      api_url: "https://cfg.api",
    }));

    const config = await import("./config.js");
    expect(config.getApiKey()).toBe("sch_cfg123456789012345");
    expect(config.getApiUrl()).toBe("https://cfg.api");
    expect(config.getWebUrl()).toBe("https://schift.io");
  });

  it("setApiKey writes config and clearApiKey removes only api_key", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ api_url: "https://cfg.api" }));

    const config = await import("./config.js");
    config.setApiKey("sch_new123456789012345");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/home/tester/.schift/config.json",
      JSON.stringify({ api_url: "https://cfg.api", api_key: "sch_new123456789012345" }, null, 2) + "\n",
    );
    expect(mockChmodSync).toHaveBeenCalledWith("/home/tester/.schift/config.json", 0o600);

    mockReadFileSync.mockReturnValue(JSON.stringify({
      api_key: "sch_new123456789012345",
      api_url: "https://cfg.api",
      other: true,
    }));
    config.clearApiKey();

    expect(mockWriteFileSync).toHaveBeenLastCalledWith(
      "/home/tester/.schift/config.json",
      JSON.stringify({ api_url: "https://cfg.api", other: true }, null, 2) + "\n",
    );
  });

  it("creates config directory when saving and file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = await import("./config.js");
    config.setApiKey("sch_new123456789012345");

    expect(mockMkdirSync).toHaveBeenCalledWith("/home/tester/.schift", { recursive: true });
  });
});
