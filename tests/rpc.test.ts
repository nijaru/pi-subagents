import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ChildRpc, type ChildEvent } from "../extensions/pi-subagents/rpc.ts";
import { MAX_PROTOCOL_LINE_BYTES, MAX_STDERR_BYTES } from "../extensions/pi-subagents/limits.ts";

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events: ChildEvent[] = [];
  const failures: Error[] = [];
  const commands: any[] = [];
  const rpc = new ChildRpc({ stdin, stdout, stderr } as unknown as ChildProcess, (event) => events.push(event), (error) => failures.push(error));
  stdin.on("data", (chunk: Buffer) => commands.push(JSON.parse(chunk.toString())));
  const send = (record: unknown) => stdout.write(JSON.stringify(record) + "\n");
  const close = () => { rpc.close(); stdin.destroy(); stdout.destroy(); stderr.destroy(); };
  return { stdin, stdout, stderr, rpc, events, failures, commands, send, close };
}

test("strict LF framing preserves multibyte text and Unicode separators across byte chunks", () => {
  const f = fixture();
  try {
    const text = "界🙂\u2028\u2029end";
    const line = Buffer.from(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) + "\r\n");
    for (const byte of line) f.stdout.write(Buffer.from([byte]));
    expect(f.events).toMatchObject([{ type: "message_update", assistantMessageEvent: { delta: text } }]);
    expect(f.failures).toEqual([]);
  } finally { f.close(); }
});

test("correlates out-of-order responses and removes cancelled command waits", async () => {
  const f = fixture();
  try {
    const one = f.rpc.request({ type: "get_state" });
    const controller = new AbortController();
    const two = f.rpc.request({ type: "get_commands" }, 1000, controller.signal);
    controller.abort();
    await expect(two).rejects.toThrow("cancelled");
    f.send({ type: "response", id: f.commands[1].id, command: "get_commands", success: true, data: { commands: [] } });
    f.send({ type: "response", id: f.commands[0].id, command: "get_state", success: true, data: { sessionId: "first" } });
    expect((await one).data.sessionId).toBe("first");
    expect(f.failures).toEqual([]);
  } finally { f.close(); }
});

test("a synchronous response cannot race request registration", async () => {
  const f = fixture();
  try {
    f.stdin.on("data", (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString());
      f.send({ type: "response", id: command.id, command: command.type, success: true, data: { commands: [] } });
    });
    expect((await f.rpc.request({ type: "get_commands" })).data.commands).toEqual([]);
  } finally { f.close(); }
});

test("malformed protocol fails pending requests rather than hanging them", async () => {
  const f = fixture();
  try {
    const pending = f.rpc.request({ type: "get_state" });
    f.stdout.write("not JSON\n");
    await expect(pending).rejects.toThrow("ended");
    expect(f.failures[0]?.message).toContain("malformed JSON");
  } finally { f.close(); }
});

test("discards oversized unused history but rejects oversized active records", () => {
  const f = fixture();
  try {
    f.stdout.write('{"type":"agent_end","messages":["');
    f.stdout.write("x".repeat(MAX_PROTOCOL_LINE_BYTES));
    f.stdout.write('"]}\n');
    f.send({ type: "agent_settled", aborted: false });
    expect(f.events).toEqual([{ type: "agent_settled", aborted: false }]);
    expect(f.failures).toEqual([]);
    f.stdout.write('{"type":"message_end","message":"' + "x".repeat(MAX_PROTOCOL_LINE_BYTES));
    expect(f.failures[0]?.message).toContain("oversized");
  } finally { f.close(); }
});

test("diagnostics remain bounded and preserve the opening and final causes", () => {
  const f = fixture();
  try {
    f.stderr.write("OPENING\n");
    for (let i = 0; i < 20; i++) f.stderr.write("x".repeat(10000));
    f.stderr.write("\nFINAL_CAUSE");
    expect(Buffer.byteLength(f.rpc.diagnostics)).toBeLessThanOrEqual(MAX_STDERR_BYTES);
    expect(f.rpc.diagnostics).toContain("OPENING");
    expect(f.rpc.diagnostics).toContain("FINAL_CAUSE");
  } finally { f.close(); }
});
