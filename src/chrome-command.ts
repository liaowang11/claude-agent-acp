import type { AvailableCommand, PromptRequest } from "@agentclientprotocol/sdk/unstable";
import type { McpServerConfig, McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { awaitCall, cleanMcpError, readMcpServerStatus } from "./mcp-command.js";

/** The name Claude Code gives the Claude in Chrome MCP server. */
export const CHROME_SERVER_NAME = "claude-in-chrome";

/** The argument that makes the Claude Code binary serve Claude in Chrome
 *  over stdio. Claude Code treats any stdio server whose command or args
 *  contain it as its Chrome server, so the config needs nothing else. */
const CHROME_SERVER_ARG = "--claude-in-chrome-mcp";

export const CHROME_COMMAND_NAME = "chrome";

/** The `/chrome` entry of `available_commands_update`. Claude Code's own
 *  `/chrome` is a terminal dialog, and the "Enabled by default" setting it
 *  changes applies only to terminal sessions, so an ACP session gets the
 *  browser tools only from `--chrome` at start or from this command. */
export const CHROME_AVAILABLE_COMMAND: AvailableCommand = {
  name: CHROME_COMMAND_NAME,
  description: "Connect Claude in Chrome to this session, or disconnect it",
  input: { hint: "[on|off]" },
};

export type ChromeCommand = { action: "status" | "on" | "off" };

/** Parse a single-text prompt that is exactly `/chrome`, `/chrome on`, or
 *  `/chrome off`. Any other prompt gives null. */
export function parseChromeCommand(prompt: PromptRequest["prompt"]): ChromeCommand | null {
  const [first] = prompt;
  if (prompt.length !== 1 || first?.type !== "text") return null;
  const match = /^\/chrome(?:\s+(\S+))?$/.exec(first.text.trim());
  if (!match) return null;
  const argument = match[1]?.toLowerCase();
  if (argument === undefined) return { action: "status" };
  return argument === "on" || argument === "off" ? { action: argument } : null;
}

export type ChromeControlQuery = Pick<
  Query,
  "mcpServerStatus" | "setMcpServers" | "toggleMcpServer" | "reconnectMcpServer"
>;

function chromeStatus(statuses: McpServerStatus[]): McpServerStatus | undefined {
  return statuses.find((status) => status.name === CHROME_SERVER_NAME);
}

function describe(status: McpServerStatus | undefined): string {
  if (status === undefined || status.status === "disabled") {
    return "Claude in Chrome is not connected. Run `/chrome on` to connect it.";
  }
  if (status.status === "connected") {
    const count = status.tools?.length ?? 0;
    return `Claude in Chrome is connected (${count === 1 ? "1 tool" : `${count} tools`}). Run \`/chrome off\` to disconnect it.`;
  }
  if (status.status === "pending") return "Claude in Chrome is connecting.";
  const error = status.error ? cleanMcpError(status.error) : "";
  const state = status.status === "needs-auth" ? "needs authentication" : "failed";
  return `Claude in Chrome ${state}${error === "" ? "." : `: ${error}`} Run \`/chrome on\` to retry.`;
}

/** Run `/chrome` and return the reply. The state comes from Claude Code's MCP
 *  status, not from a copy the adapter keeps.
 *
 *  `on` adds the Chrome server through `setMcpServers`. That call replaces the
 *  whole set of servers the SDK passed, so `sessionServers`, the
 *  `mcpServers` the session was created with, go with it; Claude Code keeps a
 *  server whose config did not change running. A disabled server is enabled
 *  and a failed one reconnected instead.
 *
 *  `off` passes `sessionServers` alone, which removes a Chrome server that
 *  `setMcpServers` added. A Chrome server that `--chrome` started belongs to
 *  Claude Code and stays; only `/mcp disable` turns it off, and Claude Code
 *  saves that in the project's `disabledMcpServers`, so the reply points to
 *  it instead of running it.
 *
 *  The server is not in `sessionServers`, so a query that the adapter
 *  recreates (a provider change) starts without it. */
export async function runChromeCommand(
  query: ChromeControlQuery,
  command: ChromeCommand,
  sessionServers: Record<string, McpServerConfig>,
  claudePath: string,
  logError: (message: string) => void,
): Promise<string> {
  const signal = new AbortController().signal;
  const before = await readMcpServerStatus(query, signal, logError);
  if (!before) return "Couldn't read the MCP server status. Try again in a moment.";
  const chrome = chromeStatus(before);
  if (command.action === "status") return describe(chrome);

  if (command.action === "on" && chrome?.status !== "connected" && chrome?.status !== "pending") {
    let serverError: string | undefined;
    const result = await awaitCall(async () => {
      if (chrome === undefined) {
        const outcome = await query.setMcpServers({
          ...sessionServers,
          [CHROME_SERVER_NAME]: { type: "stdio", command: claudePath, args: [CHROME_SERVER_ARG] },
        });
        serverError = outcome.errors[CHROME_SERVER_NAME];
      } else if (chrome.status === "disabled") {
        await query.toggleMcpServer(CHROME_SERVER_NAME, true);
      } else {
        await query.reconnectMcpServer(CHROME_SERVER_NAME);
      }
    }, signal);
    const error = result.type === "failed" ? result.error : serverError;
    if (error !== undefined) return `Couldn't connect Claude in Chrome: ${cleanMcpError(error)}`;
  }

  if (command.action === "off") {
    if (chrome === undefined || chrome.status === "disabled") {
      return "Claude in Chrome is not connected.";
    }
    const result = await awaitCall(async () => {
      await query.setMcpServers(sessionServers);
    }, signal);
    if (result.type === "failed") {
      return `Couldn't disconnect Claude in Chrome: ${cleanMcpError(result.error)}`;
    }
  }

  const after = await readMcpServerStatus(query, signal, logError);
  if (!after) return "Couldn't read the MCP server status. Try again in a moment.";
  const now = chromeStatus(after);
  if (command.action === "off") {
    if (now === undefined || now.status === "disabled") {
      return "Claude in Chrome is disconnected. Run `/chrome on` to connect it again.";
    }
    return "Claude in Chrome was connected when the session started (`--chrome`), so `/chrome off` can't remove it. Run `/mcp disable claude-in-chrome` to turn it off; Claude Code keeps that choice for this project.";
  }
  return describe(now);
}
