import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcChildSupervisor, type ChildControl } from "../extensions/pi-subagents/supervisor.ts";
import { realRpcFixture } from "./fixtures/real-rpc.ts";

function installTool(dir: string, execute: string) {
  const extension = path.join(dir, "controlled.ts");
  fs.writeFileSync(extension, `import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default (pi: any) => pi.registerTool({ name: "controlled", label: "controlled", description: "Controlled local mutation", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { ${execute} } });`);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [extension], steeringMode: "one-at-a-time" }));
}

const call = { tool_calls: [{ index: 0, id: "controlled_call", type: "function", function: { name: "controlled", arguments: "{}" } }] };

test("real steering waits for both the current model response and its tool batch", async () => {
  const requested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<typeof call>();
  const ready = Promise.withResolvers<ChildControl>();
  const toolStarted = Promise.withResolvers<void>();
  using f = realRpcFixture((body) => {
    if (body.messages.some((message: any) => message.role === "tool")) return { content: "STEERED" };
    requested.resolve();
    return response.promise;
  });
  installTool(f.dir, `fs.writeFileSync("effect", "applied"); while (!fs.existsSync("release")) await delay(10); return { content: [{ type: "text", text: "TOOL_FINISHED" }] };`);
  const abort = new AbortController();
  const run = new RpcChildSupervisor().run({
    task: { id: "steer-boundaries", prompt: "Perform the controlled operation.", cwd: f.dir, tools: ["controlled"], model: "fixture/model", executionTimeoutMs: 10_000 },
    signal: abort.signal,
    onControl: ready.resolve,
    onUpdate: (data) => { if (data.currentTool === "controlled") toolStarted.resolve(); },
  });
  try {
    await requested.promise;
    const control = await ready.promise;
    await control.steer("MODEL_BOUNDARY_MARKER");
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0].messages)).not.toContain("MODEL_BOUNDARY_MARKER");
    response.resolve(call);
    await toolStarted.promise;
    await control.steer("TOOL_BOUNDARY_MARKER");
    expect(f.requests).toHaveLength(1);
    fs.writeFileSync(path.join(f.dir, "release"), "yes");
    const result = await run;
    expect(result.outcome).toBe("completed");
    expect(f.requests).toHaveLength(3);
    const nextRequest = JSON.stringify(f.requests[1].messages);
    for (const marker of ["TOOL_FINISHED", "MODEL_BOUNDARY_MARKER"]) expect(nextRequest).toContain(marker);
    expect(nextRequest).not.toContain("TOOL_BOUNDARY_MARKER");
    expect(JSON.stringify(f.requests[2].messages)).toContain("TOOL_BOUNDARY_MARKER");
    expect(fs.readFileSync(path.join(f.dir, "effect"), "utf8")).toBe("applied");
  } finally {
    response.resolve(call);
    abort.abort();
    await run;
  }
}, 20_000);

test("timeout can leave an applied mutation without a saved tool result; resume is not rollback", async () => {
  using f = realRpcFixture((body) => JSON.stringify(body.messages).includes("RECOVERY_MARKER") ? { content: "RECOVERED" } : call);
  // Deliberately ignore cancellation after the side effect, like an external
  // service that has committed a request before the client receives its reply.
  installTool(f.dir, `fs.appendFileSync("effect", "applied\\n"); await delay(60_000); return { content: [{ type: "text", text: "TOOL_FINISHED" }] };`);
  const supervisor = new RpcChildSupervisor();
  const ready = Promise.withResolvers<ChildControl>();
  const toolStarted = Promise.withResolvers<void>();
  const pending = supervisor.run({
    task: { id: "uncertain-effect", prompt: "Perform the controlled operation.", cwd: f.dir, tools: ["controlled"], model: "fixture/model", executionTimeoutMs: 3_000 },
    signal: new AbortController().signal,
    onControl: ready.resolve,
    onUpdate: (data) => { if (data.currentTool === "controlled") toolStarted.resolve(); },
  });
  await toolStarted.promise;
  await (await ready.promise).steer("WRAP_UP_MARKER: report now without more work.");
  const first = await pending;
  expect(first.outcome).toBe("timed_out");
  expect(first.timeoutPhase).toBe("execution");
  expect(first).toMatchObject({ interruption: { activity: "tool", activeToolCount: 1, currentTool: "controlled" } });
  expect(fs.readFileSync(path.join(f.dir, "effect"), "utf8")).toBe("applied\n");
  const entries = fs.readFileSync(first.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.some((entry) => entry.message?.role === "assistant" && entry.message.content.some((block: any) => block.type === "toolCall" && block.name === "controlled"))).toBe(true);
  expect(entries.some((entry) => entry.message?.role === "toolResult")).toBe(false);
  expect(JSON.stringify(entries)).not.toContain("WRAP_UP_MARKER");
  const resumed = await supervisor.run({
    task: { id: "reconcile-effect", prompt: "RECOVERY_MARKER: inspect the existing effect before deciding whether to retry.", cwd: f.dir, tools: ["controlled"], model: "fixture/model", resume: first.sessionFile, executionTimeoutMs: 10_000 },
    signal: new AbortController().signal,
  });
  expect(resumed.outcome).toBe("completed");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].messages.some((message: any) => message.role === "tool")).toBe(true);
  expect(JSON.stringify(f.requests[1].messages)).not.toContain("TOOL_FINISHED");
  expect(JSON.stringify(f.requests[1].messages)).not.toContain("WRAP_UP_MARKER");
  expect(fs.readFileSync(path.join(f.dir, "effect"), "utf8")).toBe("applied\n");
}, 25_000);
