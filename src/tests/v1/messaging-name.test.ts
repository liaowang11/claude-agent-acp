import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import {
  cliSessionsDirectory,
  messagingNameFromRecord,
  readMessagingName,
} from "../../messaging-name.js";
import { Pushable } from "../../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/** A record as a CLI writes it to `<config dir>/sessions/<pid>.json`. */
function record(pid: number, sessionId: string, name: string, nameSource = "derived") {
  return {
    pid,
    sessionId,
    name,
    nameSource,
    messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
    kind: "interactive",
    entrypoint: "sdk-cli",
  };
}

async function writeRecord(directory: string, value: ReturnType<typeof record>) {
  await writeFile(join(directory, `${value.pid}.json`), JSON.stringify(value));
}

describe("the messaging name", () => {
  it("matches the CLI's /list-agents line", () => {
    // Both pairs were read off live `/list-agents` output.
    expect(messagingNameFromRecord(record(74239, "s", "agent-shell-74"))?.address).toBe(
      "agent-shell-74 [5223af]",
    );
    expect(
      messagingNameFromRecord(record(35448, "s", "Voice Call Eval Google Sheets", "auto")),
    ).toEqual({
      address: "Voice Call Eval Google Sheets [f3fc12]",
      name: "Voice Call Eval Google Sheets",
      nameSource: "auto",
      socketPath: "/tmp/cc-socks/35448.sock",
    });
  });

  it("needs both a name and a socket", () => {
    expect(messagingNameFromRecord({ name: "x" })).toBeUndefined();
    expect(messagingNameFromRecord({ messagingSocketPath: "/tmp/s" })).toBeUndefined();
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    expect(cliSessionsDirectory({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/sessions");
  });
});

describe("reading the messaging name", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cli-sessions-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("picks the record of the CLI session and skips unreadable ones", async () => {
    await writeRecord(directory, record(100, "cli-a", "a"));
    await writeRecord(directory, record(200, "cli-b", "b"));
    await writeFile(join(directory, "300.json"), "{not json");
    await writeFile(join(directory, "100.abc.key"), "secret");

    expect((await readMessagingName("cli-b", directory))?.name).toBe("b");
    expect(await readMessagingName("cli-missing", directory)).toBeUndefined();
    expect(await readMessagingName("cli-a", join(directory, "missing"))).toBeUndefined();
  });
});

describe("the messaging name on the wire", () => {
  let directory: string;
  let savedConfigDir: string | undefined;
  beforeEach(async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-config-"));
    directory = join(configDir, "sessions");
    await mkdir(directory);
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    await rm(join(directory, ".."), { recursive: true, force: true });
  });

  /** Collects the `_meta.claudeCode.messagingName` of every session info update. */
  function recorder() {
    const published: unknown[] = [];
    const client = {
      sessionUpdate: async (notification: any) => {
        const update = notification.update;
        if (update?.sessionUpdate !== "session_info_update") return;
        const value = update._meta?.claudeCode?.messagingName;
        if (value !== undefined) published.push({ sessionId: notification.sessionId, value });
      },
    } as unknown as AcpClient;
    return { client, published };
  }

  it("publishes for a session that has not started a turn", async () => {
    // After a setup response the CLI is up but sends no init until a prompt.
    const { client, published } = recorder();
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    await writeRecord(directory, record(74239, "cli-session", "agent-shell-74"));
    const input = new Pushable<any>();
    agent.sessions["test-session"] = {
      ...mockSessionState({ query: wrapQuery((async function* () {})()), input }, agent),
      cliSessionId: "cli-session",
    };

    await agent.publishMessagingName("test-session");
    await agent.publishMessagingName("test-session");
    await agent.publishMessagingName("unknown-session");

    expect(published.map((entry: any) => entry.value.address)).toEqual(["agent-shell-74 [5223af]"]);
  });

  it("publishes on init and again when the CLI renames the session", async () => {
    const { client, published } = recorder();
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    // The CLI's own session id differs from the ACP one after a context clear.
    await writeRecord(directory, record(74239, "cli-session", "agent-shell-74"));

    const input = new Pushable<any>();
    const stream = (async function* () {
      const iter = input[Symbol.asyncIterator]();
      // Two turns: init re-emits per turn, so the unchanged name is sent once.
      for (let turn = 0; turn < 2; turn++) {
        const { value: userMessage } = await iter.next();
        yield { type: "system", subtype: "init", session_id: "cli-session" };
        yield userEcho(userMessage);
        if (turn === 1) {
          await writeRecord(directory, record(74239, "cli-session", "Renamed", "user"));
          yield { type: "system", subtype: "session_title_changed", title: "Renamed" };
        }
        yield successfulResultMessage();
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    })();
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(stream), input }, agent);
    for (let i = 0; i < 2; i++) {
      await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: `p${i}` }] });
    }

    expect(published).toEqual([
      {
        sessionId: "test-session",
        value: {
          address: "agent-shell-74 [5223af]",
          name: "agent-shell-74",
          nameSource: "derived",
          socketPath: "/tmp/cc-socks/74239.sock",
        },
      },
      {
        sessionId: "test-session",
        value: {
          address: "Renamed [5223af]",
          name: "Renamed",
          nameSource: "user",
          socketPath: "/tmp/cc-socks/74239.sock",
        },
      },
    ]);
  });
});
