import { spawnSync } from "node:child_process";
import {
  GateExecutionError,
  type ExecutableGateDefinition,
  type ExecutableGateObject,
  type GateExecutionContext,
} from "./types.ts";

export function normalizeGate(gate: ExecutableGateDefinition): ExecutableGateObject {
  if (typeof gate === "string") {
    return { run: gate, exit_code: 0, timeout: 30_000 };
  }
  return {
    run: gate.run,
    exit_code: gate.exit_code ?? 0,
    timeout: gate.timeout ?? 30_000,
  };
}

export function executeGate(gate: ExecutableGateDefinition, ctx: GateExecutionContext): void {
  const norm = normalizeGate(gate);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKFLOW_RUN_ID: ctx.runId,
    WORKFLOW_TASK: ctx.task,
    WORKFLOW_STATE: ctx.state,
    WORKFLOW_OUTCOME: ctx.outcome ?? "",
  };

  const res = spawnSync(norm.run, {
    shell: true,
    cwd: ctx.cwd ?? process.cwd(),
    env,
    timeout: norm.timeout,
    maxBuffer: 1024 * 1024,
    encoding: "utf-8",
  });

  const output = ((res.stdout || "") + "\n" + (res.stderr || "")).trim();
  const truncated = output.split("\n").slice(-50).join("\n").slice(-4096);

  if (res.error) {
    throw new GateExecutionError(
      norm.run,
      norm.exit_code ?? 0,
      res.status,
      truncated,
      `Gate execution failed: ${res.error.message}`
    );
  }
  if (res.status !== (norm.exit_code ?? 0)) {
    throw new GateExecutionError(norm.run, norm.exit_code ?? 0, res.status, truncated);
  }
}
