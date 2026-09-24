import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { applyFlagSettingsSpy } = vi.hoisted(() => ({
  applyFlagSettingsSpy: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: (_args: { prompt: unknown; options: Options }) =>
      makeMockQuery({
        initializationResult: async () => ({
          models: [
            {
              value: "test-model",
              displayName: "Test Model",
              description: "",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
            },
          ],
        }),
        applyFlagSettings: applyFlagSettingsSpy,
      }),
  };
});

// A settings.json whose effortLevel the env override has to beat. Read via
// CLAUDE_CONFIG_DIR, which acp-agent.ts captures at module import, so the
// env var has to be in place before the dynamic import in beforeEach.
const SETTINGS_EFFORT = "high";

describe("session effort seeded from CLAUDE_CODE_EFFORT_LEVEL", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let configDir: string;
  let cwd: string;
  let previousConfigDir: string | undefined;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  function effortOption() {
    // The session id is generated per boot; grab the one session the agent
    // created.
    const sessions = (agent as unknown as { sessions: Record<string, unknown> }).sessions;
    const session = Object.values(sessions)[0] as
      { configOptions?: Array<{ id: string; currentValue?: string }> } | undefined;
    return session?.configOptions?.find((o) => o.id === "effort");
  }

  beforeEach(async () => {
    applyFlagSettingsSpy.mockClear();
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;

    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-effort-config-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-effort-cwd-"));
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ effortLevel: SETTINGS_EFFORT }),
    );
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;
    agent = new ClaudeAcpAgent(createMockClient());
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("seeds the effort option from the env override instead of settings", async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    await agent.newSession({ cwd, mcpServers: [] });

    expect(effortOption()?.currentValue).toBe("max");
  });

  it("seeds the env effort display-only without pinning it at boot", async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    await agent.newSession({ cwd, mcpServers: [] });

    expect(effortOption()?.currentValue).toBe("max");
    // The CLI resolves the env override itself ahead of session and settings
    // effort, so the flag layer stays untouched (upstream a04d354 made all
    // seeds display-only; pinning would shadow the CLI's resolution).
    expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
  });

  it("normalizes case and surrounding whitespace like the CLI", async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = " Max ";
    await agent.newSession({ cwd, mcpServers: [] });

    expect(effortOption()?.currentValue).toBe("max");
  });

  it("falls back to settings effortLevel when the env var is unset", async () => {
    await agent.newSession({ cwd, mcpServers: [] });

    expect(effortOption()?.currentValue).toBe(SETTINGS_EFFORT);
    // Display-only seed: no boot-time flag application.
    expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
  });

  it("falls back to settings effortLevel for unrecognized env values", async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "banana";
    await agent.newSession({ cwd, mcpServers: [] });

    expect(effortOption()?.currentValue).toBe(SETTINGS_EFFORT);
  });

  it("treats 'unset' and 'auto' as no explicit level and skips the boot apply", async () => {
    for (const sentinel of ["unset", "auto"]) {
      applyFlagSettingsSpy.mockClear();
      process.env.CLAUDE_CODE_EFFORT_LEVEL = sentinel;
      await agent.newSession({ cwd, mcpServers: [] });

      expect(effortOption()?.currentValue).toBe("default");
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    }
  });
});
