/**
 * The commands the adapter serves itself instead of passing to Claude Code
 * (`/remote-control`, `/plugin` and `/chrome`), in one place so that the command list and
 * the dispatch in the v1 and v2 cores apply the same rule.
 */
import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";
import type { McpServerConfig, Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import {
  CHROME_AVAILABLE_COMMAND,
  CHROME_COMMAND_NAME,
  parseChromeCommand,
  runChromeCommand,
} from "./chrome-command.js";
import { claudeCliPath, isRemoteSession } from "./claude-cli.js";
import type { NewSessionMeta } from "./new-session-meta.js";
import {
  parsePluginCommand,
  pluginCommandMarkdown,
  PLUGIN_AVAILABLE_COMMAND,
  PLUGIN_COMMAND_NAME,
  runPluginCommand,
} from "./plugin-command.js";
import {
  adapterRemoteControlCommand,
  claudeCodeOffersCommand,
  parseRemoteControlCommand,
  REMOTE_CONTROL_COMMAND_NAME,
  type RemoteControlCommand,
  runRemoteControlCommand,
  supportsRemoteControl,
} from "./remote-control.js";

type PromptContent = ReadonlyArray<{ type: string; text?: unknown }>;

export interface AdapterCommand {
  readonly name:
    typeof REMOTE_CONTROL_COMMAND_NAME | typeof PLUGIN_COMMAND_NAME | typeof CHROME_COMMAND_NAME;
  /** The `RequestError` text while Claude is working. */
  readonly busyMessage: string;
  /** The `RequestError` text while another adapter command runs. */
  readonly inFlightMessage: string;
  /** What `/remote-control` was asked to do. A core records it before the
   *  command runs, so that a restart of the query keeps what the user chose
   *  (see `RemoteControlAtStartup.commandRan`). */
  readonly remoteControl?: RemoteControlCommand;
  /** Returns the reply text. A failure is in the text: this never throws. */
  run(signal: AbortSignal): Promise<string>;
}

export interface AdapterCommandContext {
  cwd: string;
  env: Record<string, string | undefined>;
  /** The session runs Claude Code remotely (`sdk-url`). */
  remoteSession: boolean;
  query: () => Query | undefined;
  /** The `mcpServers` the query was created with. `/chrome` passes them along
   *  with the Chrome server, because `setMcpServers` replaces the whole set. A
   *  core that leaves this out does not serve `/chrome`. */
  mcpServers?: () => Record<string, McpServerConfig>;
  logError: (message: string) => void;
}

/** The session's client options (`_meta.claudeCode.options`) that decide where
 *  an adapter command runs: the CLI's `env`, and whether Claude Code is remote. */
export function sessionAdapterOptions(creationParams: { _meta?: unknown } | undefined): {
  env: Record<string, string | undefined>;
  remoteSession: boolean;
} {
  const options = (creationParams?._meta as NewSessionMeta | undefined)?.claudeCode?.options;
  return {
    env: { ...process.env, ...options?.env },
    remoteSession: isRemoteSession(options?.extraArgs),
  };
}

const REMOTE_CONTROL_ENTRY: AvailableCommand = {
  name: REMOTE_CONTROL_COMMAND_NAME,
  description:
    "Continue this session from claude.ai/code or the Claude mobile app; `off` disconnects",
  input: { hint: "[session name | off]" },
};

/** A cheap synchronous check for the cores, before any await: the prompt has
 *  the form of an adapter command. Whether the adapter serves it is
 *  {@link adapterCommand}'s decision. */
export function mayBeAdapterCommand(prompt: PromptContent): boolean {
  return (
    parseRemoteControlCommand(prompt) !== null ||
    parsePluginCommand(prompt) !== null ||
    parseChromeCommand(prompt as Parameters<typeof parseChromeCommand>[0]) !== null
  );
}

/** The adapter command of `prompt` that the adapter runs, or `null` for a
 *  prompt that goes to Claude Code. */
export async function adapterCommand(
  prompt: PromptContent,
  query: Query,
  terminalCommands: readonly string[] | undefined,
  context: AdapterCommandContext,
): Promise<AdapterCommand | null> {
  const remoteControl = await adapterRemoteControlCommand(prompt, query, terminalCommands);
  if (remoteControl) {
    return {
      name: REMOTE_CONTROL_COMMAND_NAME,
      busyMessage:
        "Remote Control can't be changed while Claude is working. Try again when the turn ends.",
      inFlightMessage: "Remote Control is already being changed. Try again in a moment.",
      remoteControl: remoteControl.command,
      run: () =>
        runRemoteControlCommand(remoteControl.query, remoteControl.command, context.logError),
    };
  }

  // `/chrome` is the adapter's own while Claude Code offers no command of that
  // name to an ACP client: Claude Code's `/chrome` is a terminal dialog.
  const chrome = parseChromeCommand(prompt as Parameters<typeof parseChromeCommand>[0]);
  const mcpServers = context.mcpServers;
  // A session with `sdk-url` runs Claude Code on another machine, where the
  // local `claude` path that `/chrome` adds as the server would not run.
  if (chrome && mcpServers && !context.remoteSession) {
    if (
      claudeCodeOffersCommand(
        await query.supportedCommands(),
        terminalCommands,
        CHROME_COMMAND_NAME,
      )
    ) {
      return null;
    }
    return {
      name: CHROME_COMMAND_NAME,
      busyMessage:
        "Claude in Chrome can't be changed while Claude is working. Try again when the turn ends.",
      inFlightMessage: "Another adapter command is running. Try again in a moment.",
      run: async () =>
        runChromeCommand(
          context.query() ?? query,
          chrome,
          mcpServers(),
          await claudeCliPath(),
          context.logError,
        ),
    };
  }

  const command = parsePluginCommand(prompt);
  // A session with `sdk-url` runs Claude Code on another machine; the CLI that
  // the adapter would start here changes the plugins of this machine instead.
  if (!command || context.remoteSession) return null;
  const typed = typedCommandName(prompt);
  if (claudeCodeOffersCommand(await query.supportedCommands(), terminalCommands, typed)) {
    return null;
  }
  return {
    name: PLUGIN_COMMAND_NAME,
    busyMessage: "/plugin can't run while Claude is working. Try again when the turn ends.",
    inFlightMessage: "Another command is still running. Try again in a moment.",
    run: async (signal) =>
      pluginCommandMarkdown(
        await runPluginCommand(command, {
          cliPath: claudeCliPath,
          cwd: context.cwd,
          env: context.env,
          signal,
          query: context.query,
          logError: context.logError,
        }),
      ),
  };
}

/** The name the user typed: `plugin`, `plugins` or `marketplace`. */
function typedCommandName(prompt: PromptContent): string {
  const text = typeof prompt[0]?.text === "string" ? prompt[0].text : "";
  return /^\/([^\s]+)/.exec(text.trim())?.[1] ?? PLUGIN_COMMAND_NAME;
}

/** The entries of `available_commands_update` that the adapter serves,
 *  without those that Claude Code offers under the same name. */
export function adapterAvailableCommands(
  commands: readonly SlashCommand[],
  terminalCommands: readonly string[] | undefined,
  query: Query | undefined,
  { remoteSession }: { remoteSession: boolean },
): AvailableCommand[] {
  const entries: AvailableCommand[] = [];
  if (query && supportsRemoteControl(query)) entries.push(REMOTE_CONTROL_ENTRY);
  if (!remoteSession) entries.push(PLUGIN_AVAILABLE_COMMAND, CHROME_AVAILABLE_COMMAND);
  return entries.filter(
    (entry) => !claudeCodeOffersCommand(commands, terminalCommands, entry.name),
  );
}
