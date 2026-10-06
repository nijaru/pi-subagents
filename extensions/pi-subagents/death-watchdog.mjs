// Detached Node sidecar: EOF on the parent's pipe also detects SIGKILL/crashes.
// Use the selected Node runtime, not shell utilities discovered on ambient PATH.
import { setTimeout as delay } from "node:timers/promises";

const pid = Number(process.argv[2]);
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid child process group.");
let stopping = false;
const signalGroup = (signal) => {
  try { process.kill(-pid, signal); return true; } catch { return false; }
};
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (!signalGroup("SIGTERM")) return;
  const until = Date.now() + 5000;
  while (signalGroup(0) && Date.now() < until) await delay(200);
  signalGroup("SIGKILL");
};
process.stdin.once("end", stop);
process.stdin.once("error", stop);
process.stdin.resume();
// A task must not be sent until the parent sees this complete readiness record.
process.stdout.end("ready\n");
