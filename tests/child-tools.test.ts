import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChildInvocation } from "../extensions/pi-subagents/subprocess.ts";
import { CHILD_PROTOCOL_VERSION, parseChildEvent } from "../extensions/pi-subagents/child-protocol.ts";

// Real SDK, built-in integrations, and stdio MCP. Only the model is local/fake.
async function run(tools: string[], tool: string, args: unknown, options: { exposure?: string; cancelStartup?: boolean } = {}) {
  const { exposure, cancelStartup } = options;
  const dir = mkdtempSync(join(tmpdir(), "pi-child-tools-"));
  let child: ReturnType<typeof spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    writeFileSync(join(dir, "fixture.txt"), "READ_OK");
    writeFileSync(join(dir, "provider.ts"), `
import {createAssistantMessageEventStream, getCurrentTools} from '@earendil-works/pi-ai';
import {writeFileSync} from 'node:fs';
export default pi => {
  pi.on('session_shutdown', () => writeFileSync(process.cwd()+'/child-shutdown','yes'));
  pi.on('tool_result', event => event.toolName === 'read' ? {usage:{input:7,output:11,reasoning:3,cacheRead:0,cacheWrite:0,totalTokens:18,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0.5}}} : undefined);
  pi.registerTool({name:'delegate_probe', label:'probe', description:'Calls a nested tool', parameters:{type:'object',properties:{target:{type:'string'}},required:['target']},
    execute:async (_id,args,signal,_update,ctx) => {
      const outcome = await ctx.executeTool(args.target, {}, {signal});
      return {content:outcome.result.content,details:undefined,isError:outcome.isError};
    }});
  if (${JSON.stringify(!exposure)}) for(const name of ['mcp__omitted__action','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']) {
    pi.registerTool({name, label:'omitted', description:'Must not execute', exposure:'codemode', parameters:{type:'object',properties:{}},
      execute:async () => {writeFileSync(process.cwd()+'/omitted-called','yes'); return {content:[{type:'text',text:'OMITTED_EXECUTED'}]};}});
  }
  pi.registerProvider('fixture', {api:'fixture-api',baseUrl:'http://unused',apiKey:'test',
    models:[{id:'model',name:'model',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},contextWindow:128000,maxTokens:4096}],
    streamSimple(model,context) {
      writeFileSync(process.cwd()+'/provider-called','yes');
      const returned=context.messages.findLast(m=>m.role==='toolResult');
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        content:returned ? [{type:'text',text:JSON.stringify({names:getCurrentTools(context.messages).map(t=>t.name),result:returned.content,isError:returned.isError})}]
          : [{type:'toolCall',id:'probe',name:${JSON.stringify(tool)},arguments:${JSON.stringify(args)}}],
        stopReason:returned?'stop':'toolUse'};
      const stream=createAssistantMessageEventStream();
      queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});
      return stream;
    }});
};`);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [join(dir, "provider.ts")] }));
    if (exposure) {
      writeFileSync(join(dir, "server.mjs"), `
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const input=createInterface({input:process.stdin});
for await (const line of input) {
  const request=JSON.parse(line); if(request.id===undefined) continue;
  let result;
  if(request.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(request.method==='tools/list') {writeFileSync('mcp-listing','yes');await new Promise(resolve=>setTimeout(resolve,${cancelStartup ? 10000 : 100}));result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{}}}]};}
  else if(request.method==='tools/call') result={content:[{type:'text',text:'MCP_OK'}]};
  else if(request.method==='resources/read') result={contents:[{uri:request.params.uri,mimeType:'text/plain',text:'RESOURCE_OK'}]};
  else if(request.method==='resources/list') result={resources:[]};
  else if(request.method==='resources/templates/list') result={resourceTemplates:[]};
  else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}`);
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: {
        command: "node", args: [join(dir, "server.mjs")], exposure,
      } } }));
    }
    const invocation = getChildInvocation();
    child = spawn(invocation.command, invocation.args, {
      cwd: dir, env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const read = async (stream: AsyncIterable<Buffer>) => { let text = ""; for await (const chunk of stream) text += chunk; return text; };
    const stdout = read(child.stdout!);
    const stderr = read(child.stderr!);
    const wire = read(child.stdio[3] as AsyncIterable<Buffer>);
    const closed = new Promise((resolve, reject) => { child!.once("close", resolve); child!.once("error", reject); });
    deadline = setTimeout(() => child?.kill("SIGKILL"), 15000);
    child.stdin!.end(JSON.stringify({ version: CHILD_PROTOCOL_VERSION, prompt: "Exercise the selected tool.", model: "fixture/model", tools }));
    if (cancelStartup) {
      const until = Date.now() + 5000;
      while (!existsSync(join(dir, "mcp-listing")) && Date.now() < until) await Bun.sleep(10);
      expect(existsSync(join(dir, "mcp-listing"))).toBe(true);
      child.kill("SIGTERM");
      clearTimeout(deadline);
      deadline = setTimeout(() => child?.kill("SIGKILL"), 5000);
    }
    const code = await closed;
    const events = (await wire).trim().split("\n").map(parseChildEvent);
    return { code, events, stdout: await stdout, stderr: await stderr,
      omittedCalled: existsSync(join(dir, "omitted-called")), providerCalled: existsSync(join(dir, "provider-called")),
      shutdown: existsSync(join(dir, "child-shutdown")) };
  } finally {
    clearTimeout(deadline);
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each(["mcp__omitted__action", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])("child allowlist blocks omitted nested MCP tool: %s", async (target) => {
  const result = await run(["delegate_probe"], "delegate_probe", { target });
  expect(result.code).toBe(0);
  expect(result.omittedCalled).toBe(false);
  const report = result.events.at(-1) as any;
  expect(JSON.parse(report.report.output)).toMatchObject({ names: ["delegate_probe"], isError: true });
});

test("SDK child codemode accounts paid nested work exactly once", async () => {
  const result = await run(["read", "codemode"], "codemode", { code: "text(await tools.read({path:'fixture.txt'}));" });
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toMatchObject({ kind: "result" });
  expect((result.events.at(-1) as any).report.output).toContain("READ_OK");
  expect(result.omittedCalled).toBe(false);
  expect((result.events.at(-1) as any).usage).toMatchObject({ input: 9, output: 13, reasoning: 3, totalTokens: 22, turns: 2, cost: { total: 0.5 } });
});

test("cancelling MCP readiness closes the startup-owned session without prompting", async () => {
  const result = await run(["mcp__fixture__echo"], "mcp__fixture__echo", {}, { exposure: "codemode", cancelStartup: true });
  expect(result.code).toBe(1);
  expect(result.events.some((event) => event.kind === "ready")).toBe(false);
  expect(result.events.at(-1)).toMatchObject({ kind: "error" });
  expect(result.providerCalled).toBe(false);
  expect(result.shutdown).toBe(true);
}, 15000);

test("child waits for an explicitly selected asynchronous MCP resource tool", async () => {
  const result = await run(["read_mcp_resource"], "read_mcp_resource", { server: "fixture", uri: "fixture:///data" }, { exposure: "codemode" });
  expect(result.code).toBe(0);
  const report = result.events.at(-1) as any;
  expect(JSON.parse(report.report.output)).toMatchObject({ names: ["read_mcp_resource"], isError: false });
  expect(report.report.output).toContain("RESOURCE_OK");
});

test.each(["direct", "codemode"])("child waits for an explicitly selected asynchronous MCP tool (%s)", async (exposure) => {
  const result = await run(["mcp__fixture__echo"], "mcp__fixture__echo", {}, { exposure });
  expect(result.code).toBe(0);
  const report = result.events.at(-1) as any;
  expect(JSON.parse(report.report.output)).toMatchObject({ names: ["mcp__fixture__echo"], isError: false });
  expect(report.report.output).toContain("MCP_OK");
  expect(result.omittedCalled).toBe(false);
}, 20000);
