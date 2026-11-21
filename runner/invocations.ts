import type { DatabaseSync } from "node:sqlite";
import { pauseRun, getRun } from "./db.ts";
import type { InvocationRecord } from "./types.ts";

export type { InvocationRecord };

export interface CreateInvocationOptions {
  taskSlug?: string;
  childRunId?: string;
  worktree?: string;
  branch?: string;
  entryOverride?: string;
}

export function getLoopCount(db: DatabaseSync, runId: string, transitionId: string): number {
  const row = db.prepare(`
    SELECT count FROM loop_counts WHERE run_id = ? AND transition_id = ?
  `).get(runId, transitionId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function checkAndIncrementLoop(
  db: DatabaseSync,
  runId: string,
  transitionId: string,
  maxRetries = 2
): { allowed: boolean; count: number } {
  const current = getLoopCount(db, runId, transitionId);
  if (current >= maxRetries) {
    const run = getRun(db, runId);
    if (run) {
      pauseRun(
        db,
        runId,
        run.revision,
        `Loop thrash guard: transition '${transitionId}' reached retry limit of ${maxRetries}`
      );
    }
    return { allowed: false, count: current };
  }

  const nextCount = current + 1;
  db.prepare(`
    INSERT INTO loop_counts (run_id, transition_id, count)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id, transition_id) DO UPDATE SET count = excluded.count
  `).run(runId, transitionId, nextCount);

  return { allowed: true, count: nextCount };
}

export function resetLoopCount(db: DatabaseSync, runId: string, transitionId: string): void {
  db.prepare("DELETE FROM loop_counts WHERE run_id = ? AND transition_id = ?").run(runId, transitionId);
}

export function createChildInvocation(
  db: DatabaseSync,
  parentRunId: string,
  childWorkflow: string,
  entryOverrideOrOptions?: string | CreateInvocationOptions
): InvocationRecord {
  const options: CreateInvocationOptions =
    typeof entryOverrideOrOptions === "string"
      ? { entryOverride: entryOverrideOrOptions }
      : entryOverrideOrOptions ?? {};

  const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO invocations (
      parent_run_id,
      invocation_id,
      child_workflow,
      entry_override,
      task_slug,
      child_run_id,
      worktree,
      branch,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    parentRunId,
    invocationId,
    childWorkflow,
    options.entryOverride ?? null,
    options.taskSlug ?? null,
    options.childRunId ?? null,
    options.worktree ?? null,
    options.branch ?? null
  );

  return db.prepare("SELECT * FROM invocations WHERE invocation_id = ?").get(invocationId) as InvocationRecord;
}

export function getActiveInvocations(db: DatabaseSync, parentRunId: string): InvocationRecord[] {
  return db.prepare(`
    SELECT * FROM invocations
    WHERE parent_run_id = ? AND status = 'active'
    ORDER BY id ASC
  `).all(parentRunId) as InvocationRecord[];
}

export function getActiveInvocation(db: DatabaseSync, parentRunId: string): InvocationRecord | null {
  const row = db.prepare(`
    SELECT * FROM invocations
    WHERE parent_run_id = ? AND status = 'active'
    ORDER BY id DESC LIMIT 1
  `).get(parentRunId) as InvocationRecord | undefined;
  return row ?? null;
}

export function getInvocationByTask(db: DatabaseSync, parentRunId: string, taskSlug: string): InvocationRecord | null {
  const row = db.prepare(`
    SELECT * FROM invocations
    WHERE parent_run_id = ? AND task_slug = ?
    ORDER BY id DESC LIMIT 1
  `).get(parentRunId, taskSlug) as InvocationRecord | undefined;
  return row ?? null;
}

export function completeInvocationByTask(
  db: DatabaseSync,
  parentRunId: string,
  taskSlug: string,
  outcome: "completed" | "aborted"
): void {
  db.prepare(`
    UPDATE invocations
    SET status = ?, finished_at = datetime('now')
    WHERE parent_run_id = ? AND task_slug = ? AND status = 'active'
  `).run(outcome, parentRunId, taskSlug);
}

export function completeChildInvocation(
  db: DatabaseSync,
  invocationId: string,
  outcome: "completed" | "aborted"
): void {
  db.prepare(`
    UPDATE invocations
    SET status = ?, finished_at = datetime('now')
    WHERE invocation_id = ?
  `).run(outcome, invocationId);
}
