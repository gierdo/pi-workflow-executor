import test from "node:test";
import assert from "node:assert/strict";
import {
  initDatabase,
  createRun,
  getRun,
  executeTransition,
  pauseRun,
  completeRun,
  createPendingApproval,
  deleteRun,
  getStateVisits,
} from "../runner/db.ts";

test("deleteRun removes completed run and cascades to all child tables", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "run-comp",
    task: "task-1",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });

  // Advance state
  executeTransition(db, {
    runId: "run-comp",
    expectedRevision: 1,
    toState: "middle",
  });

  // Add pending approval
  const visit = getStateVisits(db, "run-comp")[1]!;
  createPendingApproval(db, "run-comp", visit.id, "end", 2, "need signoff");

  // Add rows into external_actions, loop_counts, invocations
  db.prepare(`
    INSERT INTO external_actions (run_id, action, payload, status)
    VALUES ('run-comp', 'notify', '{"msg": "hi"}', 'confirmed')
  `).run();
  db.prepare(`
    INSERT INTO loop_counts (run_id, transition_id, count)
    VALUES ('run-comp', 't1', 1)
  `).run();
  db.prepare(`
    INSERT INTO invocations (parent_run_id, invocation_id, child_workflow, status)
    VALUES ('run-comp', 'inv-1', 'child-wf', 'completed')
  `).run();

  // Complete the run
  completeRun(db, "run-comp", 2, "completed");
  assert.equal(getRun(db, "run-comp")?.status, "completed");

  // Now delete run
  deleteRun(db, "run-comp");

  // Verify run is gone
  assert.equal(getRun(db, "run-comp"), null);

  // Verify child tables have zero rows for run-comp
  assert.equal(
    (db.prepare("SELECT COUNT(*) as count FROM state_visits WHERE run_id = 'run-comp'").get() as any).count,
    0
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) as count FROM transitions WHERE run_id = 'run-comp'").get() as any).count,
    0
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) as count FROM pending_approvals WHERE run_id = 'run-comp'").get() as any).count,
    0
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) as count FROM external_actions WHERE run_id = 'run-comp'").get() as any).count,
    0
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) as count FROM loop_counts WHERE run_id = 'run-comp'").get() as any).count,
    0
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) as count FROM invocations WHERE parent_run_id = 'run-comp'").get() as any).count,
    0
  );
});

test("deleteRun removes aborted run successfully", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "run-abort",
    task: "task-2",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });

  completeRun(db, "run-abort", 1, "aborted");
  assert.equal(getRun(db, "run-abort")?.status, "aborted");

  deleteRun(db, "run-abort");
  assert.equal(getRun(db, "run-abort"), null);
});

test("deleteRun guards: cannot delete active run", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "run-act",
    task: "task-3",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });

  assert.throws(
    () => deleteRun(db, "run-act"),
    /Cannot delete run in 'active' state/
  );
  assert.ok(getRun(db, "run-act"));
});

test("deleteRun guards: cannot delete paused run", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "run-pause",
    task: "task-4",
    workflow: "test-wf",
    initialState: "start",
    definitionFingerprint: "fp1",
  });
  pauseRun(db, "run-pause", 1, "waiting for user input");

  assert.throws(
    () => deleteRun(db, "run-pause"),
    /Cannot delete run in 'paused' state/
  );
  assert.ok(getRun(db, "run-pause"));
});

test("deleteRun throws on nonexistent run", () => {
  const db = initDatabase(":memory:");
  assert.throws(
    () => deleteRun(db, "nonexistent"),
    /Run 'nonexistent' not found/
  );
});

test("getStateVisits returns visits ordered by id", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "run-visits",
    task: "task-5",
    workflow: "test-wf",
    initialState: "s1",
    definitionFingerprint: "fp1",
  });
  executeTransition(db, {
    runId: "run-visits",
    expectedRevision: 1,
    toState: "s2",
  });

  const visits = getStateVisits(db, "run-visits");
  assert.equal(visits.length, 2);
  assert.equal(visits[0]?.state_id, "s1");
  assert.equal(visits[1]?.state_id, "s2");
});
