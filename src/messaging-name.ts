/**
 * The name other Claude Code sessions use to message this one.
 *
 * Claude Code's `/list-agents` prints it as "This session: <name> [<ref>]".
 * The SDK stream carries neither part, but every interactive CLI records its
 * session in `<config dir>/sessions/<pid>.json`: the registered `name` and the
 * `messagingSocketPath` whose hash is the ref. The adapter reads that record
 * on the host the CLI runs on, so a client of a remote adapter gets the name
 * without reaching that host's files itself.
 *
 * It travels as `session_info_update._meta.claudeCode.messagingName`. The
 * record format and the ref recipe are CLI internals, so the value also
 * carries the parts it was built from.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The `_meta.claudeCode` key the name travels under. */
export const MESSAGING_NAME_META_KEY = "messagingName";

/** The parts of a CLI session record this module reads. */
export type CliSessionRecord = {
  sessionId?: unknown;
  name?: unknown;
  nameSource?: unknown;
  messagingSocketPath?: unknown;
};

/** The `_meta.claudeCode.messagingName` value. */
export type MessagingName = {
  /** What `/list-agents` shows, for example "agent-shell-74 [5223af]". */
  address: string;
  name: string;
  /** `derived`, `auto` or `user`, as the CLI records it. */
  nameSource?: string;
  socketPath: string;
};

/** The directory the CLI records running sessions in. */
export function cliSessionsDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
}

/**
 * The messaging name a record describes, or `undefined` when it lacks a name
 * or a socket. The ref is the first 6 hex digits of
 * `sha256("session:" + socketPath)`, as the CLI computes it for its own
 * `/list-agents` line.
 */
export function messagingNameFromRecord(record: CliSessionRecord): MessagingName | undefined {
  const { name, nameSource, messagingSocketPath: socketPath } = record;
  if (typeof name !== "string" || !name || typeof socketPath !== "string" || !socketPath) {
    return undefined;
  }
  const ref = createHash("sha256").update(`session:${socketPath}`).digest("hex").slice(0, 6);
  return {
    address: `${name} [${ref}]`,
    name,
    ...(typeof nameSource === "string" ? { nameSource } : {}),
    socketPath,
  };
}

/**
 * Reads the messaging name of the CLI running `cliSessionId` from `directory`.
 * `undefined` when no record matches or the directory is missing; a record
 * that fails to parse (one being rewritten, say) is skipped.
 */
export async function readMessagingName(
  cliSessionId: string,
  directory: string = cliSessionsDirectory(),
): Promise<MessagingName | undefined> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let record: CliSessionRecord;
    try {
      record = JSON.parse(await readFile(join(directory, file), "utf8"));
    } catch {
      continue;
    }
    if (record?.sessionId === cliSessionId) {
      return messagingNameFromRecord(record);
    }
  }
  return undefined;
}

/** The `_meta` of the session info update that publishes `name`. */
export function messagingNameMeta(name: MessagingName): Record<string, unknown> {
  return { claudeCode: { [MESSAGING_NAME_META_KEY]: name } };
}
