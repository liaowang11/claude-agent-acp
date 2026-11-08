import { describe, it, expect, vi } from "vitest";
import type { McpServerConfig, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { CHROME_SERVER_NAME, parseChromeCommand } from "../../chrome-command.js";
import { claudeCliPath } from "../../claude-cli.js";
import { mockSessionState } from "./session-doubles.js";

/** A stream that stays open, like the real one: a consumer that reaches its end
 *  closes the session. */
async function* openStream(): AsyncGenerator<never> {
  await new Promise<never>(() => {});
  yield* [];
}

const BASE: Record<string, McpServerConfig> = {
  github: { type: "stdio", command: "github-mcp", args: [] },
};

const TOOLS = Array.from({ length: 22 }, (_, index) => ({ name: `tool${index}` }));

/** A query whose MCP status follows the control calls the way Claude Code's
 *  does: `setMcpServers` connects the servers it adds and disconnects the
 *  ones it drops, except the Chrome server that `--chrome` started, which the
 *  CLI owns and keeps. */
function chromeQuery(chrome: McpServerStatus["status"] | "absent", owner: "sdk" | "cli" = "sdk") {
  let servers: McpServerStatus[] = [{ name: "github", status: "connected", scope: "dynamic" }];
  if (chrome !== "absent") {
    servers.push({
      name: CHROME_SERVER_NAME,
      status: chrome,
      scope: "dynamic",
      ...(chrome === "connected" ? { tools: TOOLS } : {}),
      ...(chrome === "failed" ? { error: "MCP error -32000: Connection closed" } : {}),
    });
  }
  const setChrome = (status: McpServerStatus["status"]) => {
    servers = servers.map((server) =>
      server.name === CHROME_SERVER_NAME
        ? {
            name: server.name,
            status,
            scope: server.scope,
            ...(status === "connected" ? { tools: TOOLS } : {}),
          }
        : server,
    );
  };
  const query = {
    mcpServerStatus: vi.fn(async () => servers),
    setMcpServers: vi.fn(async (next: Record<string, McpServerConfig>) => {
      const present = servers.some((server) => server.name === CHROME_SERVER_NAME);
      if (CHROME_SERVER_NAME in next && !present) {
        servers = [
          ...servers,
          { name: CHROME_SERVER_NAME, status: "connected", scope: "dynamic", tools: TOOLS },
        ];
        return { added: [CHROME_SERVER_NAME], removed: [], errors: {} };
      }
      if (!(CHROME_SERVER_NAME in next) && present && owner === "sdk") {
        servers = servers.filter((server) => server.name !== CHROME_SERVER_NAME);
        return { added: [], removed: [CHROME_SERVER_NAME], errors: {} };
      }
      return { added: [], removed: [], errors: {} };
    }),
    toggleMcpServer: vi.fn(async (_name: string, enabled: boolean) =>
      setChrome(enabled ? "connected" : "disabled"),
    ),
    reconnectMcpServer: vi.fn(async () => setChrome("connected")),
  };
  return query;
}

function createAgent(query: Record<string, unknown>, sessionOverrides: Record<string, any> = {}) {
  const sessionUpdate = vi.fn(async () => {});
  const client = { sessionUpdate } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  agent.sessions["session-1"] = mockSessionState({
    query: Object.assign(openStream(), { supportedCommands: async () => [] }, query),
    mcpServers: BASE,
    ...sessionOverrides,
  });
  return { agent, sessionUpdate };
}

const prompt = (text: string) => ({
  sessionId: "session-1",
  prompt: [{ type: "text" as const, text }],
});

const messageText = (sessionUpdate: ReturnType<typeof createAgent>["sessionUpdate"]) =>
  (sessionUpdate.mock.calls as any[][]).at(-1)?.[0].update.content.text;

describe("parseChromeCommand", () => {
  it.each([
    ["/chrome", { action: "status" }],
    ["  /chrome on ", { action: "on" }],
    ["/chrome OFF", { action: "off" }],
  ] as const)("parses %j", (text, expected) => {
    expect(parseChromeCommand(prompt(text).prompt)).toEqual(expected);
  });

  it.each(["/chrome please", "/chromeon", "hello /chrome", "/chrome on now"])(
    "leaves %j alone",
    (text) => {
      expect(parseChromeCommand(prompt(text).prompt)).toBeNull();
    },
  );
});

describe("/chrome", () => {
  it("adds the Chrome server next to the session's own servers", async () => {
    const query = chromeQuery("absent");
    const { agent, sessionUpdate } = createAgent(query);

    const response = await agent.prompt(prompt("/chrome on"));

    expect(response.stopReason).toBe("end_turn");
    expect(query.setMcpServers).toHaveBeenCalledExactlyOnceWith({
      ...BASE,
      [CHROME_SERVER_NAME]: {
        type: "stdio",
        command: await claudeCliPath(),
        args: ["--claude-in-chrome-mcp"],
      },
    });
    expect(messageText(sessionUpdate)).toContain("Claude in Chrome is connected (22 tools)");
  });

  it.each([
    ["disabled", "toggleMcpServer", [CHROME_SERVER_NAME, true]],
    ["failed", "reconnectMcpServer", [CHROME_SERVER_NAME]],
    ["needs-auth", "reconnectMcpServer", [CHROME_SERVER_NAME]],
  ] as const)("brings a %s Chrome server back with %s", async (status, method, args) => {
    const query = chromeQuery(status);
    const { agent, sessionUpdate } = createAgent(query);

    await agent.prompt(prompt("/chrome on"));

    expect(query[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(query.setMcpServers).not.toHaveBeenCalled();
    expect(messageText(sessionUpdate)).toContain("Claude in Chrome is connected (22 tools)");
  });

  it("changes nothing when Chrome is already connected", async () => {
    const query = chromeQuery("connected");
    const { agent, sessionUpdate } = createAgent(query);

    await agent.prompt(prompt("/chrome on"));

    expect(query.setMcpServers).not.toHaveBeenCalled();
    expect(query.toggleMcpServer).not.toHaveBeenCalled();
    expect(messageText(sessionUpdate)).toContain("Claude in Chrome is connected (22 tools)");
  });

  it("reports the error Claude Code returns for the server", async () => {
    const query = chromeQuery("absent");
    query.setMcpServers.mockImplementation(async () => ({
      added: [CHROME_SERVER_NAME],
      removed: [],
      errors: { [CHROME_SERVER_NAME]: "Claude in Chrome requires a claude.ai subscription" },
    }));
    const { agent, sessionUpdate } = createAgent(query);

    await agent.prompt(prompt("/chrome on"));

    expect(messageText(sessionUpdate)).toContain(
      "Couldn't connect Claude in Chrome: Claude in Chrome requires a claude.ai subscription",
    );
  });

  it("removes the Chrome server it added and keeps the session's own servers", async () => {
    const query = chromeQuery("connected", "sdk");
    const { agent, sessionUpdate } = createAgent(query);

    await agent.prompt(prompt("/chrome off"));

    expect(query.setMcpServers).toHaveBeenCalledExactlyOnceWith(BASE);
    expect(query.toggleMcpServer).not.toHaveBeenCalled();
    expect(messageText(sessionUpdate)).toContain("Claude in Chrome is disconnected");
  });

  it("points to /mcp disable for a Chrome server that --chrome started", async () => {
    const query = chromeQuery("connected", "cli");
    const { agent, sessionUpdate } = createAgent(query);

    await agent.prompt(prompt("/chrome off"));

    // A disable persists in the project's `disabledMcpServers`, so the command
    // leaves that choice to the user.
    expect(query.toggleMcpServer).not.toHaveBeenCalled();
    expect(messageText(sessionUpdate)).toContain("--chrome");
    expect(messageText(sessionUpdate)).toContain("/mcp disable claude-in-chrome");
  });

  it.each(["absent", "disabled"] as const)(
    "changes nothing on off when Chrome is %s",
    async (status) => {
      const query = chromeQuery(status);
      const { agent, sessionUpdate } = createAgent(query);

      await agent.prompt(prompt("/chrome off"));

      expect(query.setMcpServers).not.toHaveBeenCalled();
      expect(messageText(sessionUpdate)).toContain("Claude in Chrome is not connected");
    },
  );

  it("reports the state without changing it", async () => {
    const query = chromeQuery("failed");
    const { agent, sessionUpdate } = createAgent(query);

    await agent.prompt(prompt("/chrome"));

    expect(query.setMcpServers).not.toHaveBeenCalled();
    expect(query.reconnectMcpServer).not.toHaveBeenCalled();
    expect(messageText(sessionUpdate)).toContain("Claude in Chrome failed: Connection closed");
    expect(messageText(sessionUpdate)).toContain("/chrome on");
  });

  it("refuses the command while a turn is still running", async () => {
    const query = chromeQuery("absent");
    const { agent, sessionUpdate } = createAgent(query, { turnQueue: [{ settled: false }] });

    await expect(agent.prompt(prompt("/chrome on"))).rejects.toThrow(/while Claude is working/);

    expect(query.setMcpServers).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("leaves /chrome to Claude Code when Claude Code offers it", async () => {
    const query = chromeQuery("absent");
    const push = vi.fn();
    async function* noMessages() {}
    const { agent } = createAgent(
      Object.assign(noMessages(), query, {
        supportedCommands: async () => [{ name: "chrome", description: "", argumentHint: "" }],
      }) as any,
      { input: { push } },
    );

    await agent.startTurn(prompt("/chrome on"), { inserted() {}, ended() {}, failed() {} });

    expect(query.setMcpServers).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledOnce();
  });

  it("is advertised unless Claude Code offers its own /chrome", async () => {
    const offered = async () => [{ name: "chrome", description: "", argumentHint: "" }];
    const own = createAgent(chromeQuery("absent"));
    const claudeCode = createAgent({ ...chromeQuery("absent"), supportedCommands: offered });

    await (own.agent as any).sendAvailableCommandsUpdate("session-1");
    await (claudeCode.agent as any).sendAvailableCommandsUpdate("session-1");

    const chromeEntries = (update: ReturnType<typeof createAgent>["sessionUpdate"]) =>
      (update.mock.calls as any[][])[0][0].update.availableCommands.filter(
        (command: any) => command.name === "chrome",
      );
    expect(chromeEntries(own.sessionUpdate)).toEqual([
      expect.objectContaining({ input: { hint: "[on|off]" } }),
    ]);
    expect(chromeEntries(claudeCode.sessionUpdate)).toEqual([
      expect.objectContaining({ description: "" }),
    ]);
  });
});
