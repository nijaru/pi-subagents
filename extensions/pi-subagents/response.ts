import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { boundDetails, jsonBytes, minimalChildResult } from "./bounds.ts";
import { MAX_OUTPUT_BYTES } from "./limits.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";

/** Select one view that fits both wire and text budgets; all consumers see it. */
export function childResponse(
  command: SubagentDetails["command"],
  results: ChildResult[],
  format: (view: ChildResult[]) => string,
  waitExpired?: boolean,
): AgentToolResult<SubagentDetails> {
  const source = { command, results, ...(waitExpired === undefined ? {} : { waitExpired }) };
  const project = (budget: number) => {
    const details = boundDetails(source, budget);
    return { details, text: format(details.results) };
  };
  const fits = (view: ReturnType<typeof project>) => Buffer.byteLength(view.text) <= MAX_OUTPUT_BYTES;
  let selected = project(MAX_OUTPUT_BYTES);
  if (!fits(selected)) {
    let low = jsonBytes({ ...source, results: results.map(minimalChildResult) });
    let high = MAX_OUTPUT_BYTES - 1;
    selected = project(low);
    if (!fits(selected)) throw new RangeError("Response budget cannot hold all child identities and required diagnostics");
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = project(middle);
      if (fits(candidate)) { selected = candidate; low = middle + 1; }
      else high = middle - 1;
    }
  }
  return { content: [{ type: "text", text: selected.text }], details: selected.details, structuredContent: selected.details };
}
