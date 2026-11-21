import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RunRecord } from "../runner/types.ts";
import { deleteRun } from "../runner/db.ts";

export function removeWorkflowRun(
  db: DatabaseSync,
  run: RunRecord,
  projectRoot: string = process.cwd()
): void {
  deleteRun(db, run.id);

  const journalDir = join(projectRoot, ".workflow", "runs", run.workflow, run.task);
  if (existsSync(journalDir)) {
    try {
      rmSync(journalDir, { recursive: true, force: true });
    } catch {
      // Ignore filesystem cleanup errors if directory cannot be removed
    }
  }
}
