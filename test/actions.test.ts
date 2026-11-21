import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase, createRun, completeRun, getRun } from "../runner/db.ts";
import { removeWorkflowRun } from "../tui/actions.ts";

test("removeWorkflowRun removes DB records and disk journal directory", () => {
  const db = initDatabase(":memory:");
  const testDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const journalDir = join(testDir, ".workflow", "runs", "test-wf", "task-abc");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "workflow-log.md"), "# Log");

  assert.ok(existsSync(journalDir));

  const run = createRun(db, {
    id: "test-run-1",
    task: "task-abc",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });
  completeRun(db, "test-run-1", 1, "completed");
  const completedRun = getRun(db, "test-run-1")!;

  removeWorkflowRun(db, completedRun, testDir);

  // Assert DB record removed
  assert.equal(getRun(db, "test-run-1"), null);

  // Assert journal directory removed
  assert.equal(existsSync(journalDir), false);
});

test("removeWorkflowRun succeeds if journal directory does not exist", () => {
  const db = initDatabase(":memory:");
  const testDir = join(tmpdir(), `pi-test-missing-${Date.now()}`);

  const run = createRun(db, {
    id: "test-run-2",
    task: "missing-task",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });
  completeRun(db, "test-run-2", 1, "aborted");
  const abortedRun = getRun(db, "test-run-2")!;

  removeWorkflowRun(db, abortedRun, testDir);
  assert.equal(getRun(db, "test-run-2"), null);
});

test("removeWorkflowRun throws on active run and preserves journal folder", () => {
  const db = initDatabase(":memory:");
  const testDir = join(tmpdir(), `pi-test-active-${Date.now()}`);
  const journalDir = join(testDir, ".workflow", "runs", "test-wf", "active-task");
  mkdirSync(journalDir, { recursive: true });

  const run = createRun(db, {
    id: "test-run-active",
    task: "active-task",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });

  assert.throws(
    () => removeWorkflowRun(db, run, testDir),
    /Cannot delete run in 'active' state/
  );
  assert.ok(getRun(db, "test-run-active"));
  assert.ok(existsSync(journalDir));
});
