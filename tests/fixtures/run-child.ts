import { RpcChildSupervisor } from "../../extensions/pi-subagents/supervisor.ts";
import type { ProcessRuntime } from "../../extensions/pi-subagents/supervisor.ts";
import type { ChildExecution, ChildTask, ExecutionFacts } from "../../extensions/pi-subagents/execution.ts";

export type ExecutionUpdate = ExecutionFacts & { phase?: "starting" | "running" | "stopping" };
export type ExecutionControl = Pick<ChildExecution, "steer">;

/** Test driver for the actual execution owner; no fake RPC/lifecycle behavior. */
export async function runChild({ task, signal, onUpdate, onReady }: {
  task: ChildTask;
  signal?: AbortSignal;
  onUpdate?: (data: ExecutionUpdate, progress?: string) => void;
  onReady?: (control: ExecutionControl) => void;
}, runtime?: ProcessRuntime) {
  const execution = new RpcChildSupervisor(runtime).create(task);
  const abort = () => execution.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let ready = false;
  execution.start((progress) => {
    const snapshot = execution.snapshot();
    if (snapshot.status === "active") {
      onUpdate?.({ ...snapshot.facts, phase: snapshot.phase }, progress);
      if (!ready && snapshot.phase === "running") {
        ready = true;
        onReady?.({ steer: (message, signal) => execution.steer(message, signal) });
      }
    }
  });
  try { return await execution.done; }
  finally { signal?.removeEventListener("abort", abort); }
}
