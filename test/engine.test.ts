import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase, getRun, getPendingApproval } from "../runner/db.ts";
import {
  startWorkflowRun,
  resumeWorkflowRun,
  submitOutcome,
  confirmPendingApproval,
} from "../runner/engine.ts";
import { GateExecutionError, type WorkflowDefinition } from "../runner/types.ts";

const mockDefYaml = `
name: sample-workflow
initial: intake
states:
  intake:
    transitions:
      - outcome: valid
        to: review
        reason: "task valid"
  review:
    transitions:
      - outcome: approved
        to: deploy
        reason: "deploy approved"
        requires_approval: true
      - outcome: retry
        to: intake
        reason: "retry intake"
  deploy:
    terminal: true
`;

const mockDef: WorkflowDefinition = {
  name: "sample-workflow",
  initial: "intake",
  states: {
    intake: {
      transitions: [
        { outcome: "valid", to: "review", reason: "task valid" }
      ]
    },
    review: {
      transitions: [
        { outcome: "approved", to: "deploy", reason: "deploy approved", requires_approval: true },
        { outcome: "retry", to: "intake", reason: "retry intake" }
      ]
    },
    deploy: {
      terminal: true
    }
  }
};

test("startWorkflowRun creates new run and verifies fingerprint", () => {
  const db = initDatabase(":memory:");
  const run = startWorkflowRun(db, mockDef, mockDefYaml, "test-task", "r-1");
  assert.equal(run.id, "r-1");
  assert.equal(run.current_state, "intake");
  assert.equal(run.revision, 1);
});

test("resumeWorkflowRun detects fingerprint mismatch and blocks (ISC 7)", () => {
  const db = initDatabase(":memory:");
  startWorkflowRun(db, mockDef, mockDefYaml, "test-task", "r-1");

  const alteredYaml = mockDefYaml + "\n# altered definition";
  assert.throws(() => {
    resumeWorkflowRun(db, mockDef, alteredYaml, "r-1");
  }, /Definition fingerprint mismatch: resume blocked/);

  const run = getRun(db, "r-1");
  assert.equal(run?.status, "paused");
});

test("submitOutcome pauses run on unknown outcome (ISC 3)", () => {
  const db = initDatabase(":memory:");
  startWorkflowRun(db, mockDef, mockDefYaml, "test-task", "r-1");

  const result = submitOutcome(db, mockDef, {
    runId: "r-1",
    outcomeId: "unknown_weird_outcome",
    expectedRevision: 1,
  });

  assert.equal(result.status, "paused");
  assert.ok(result.reason?.includes("Unknown outcome"));

  const run = getRun(db, "r-1");
  assert.equal(run?.status, "paused");
  assert.equal(run?.current_state, "intake"); // Did not advance
});

test("approval-gated transition creates pending approval and pauses (ISC 4)", () => {
  const db = initDatabase(":memory:");
  startWorkflowRun(db, mockDef, mockDefYaml, "test-task", "r-1");

  // Advance intake -> review
  submitOutcome(db, mockDef, { runId: "r-1", outcomeId: "valid", expectedRevision: 1 });

  // Submit outcome that requires approval
  const res = submitOutcome(db, mockDef, { runId: "r-1", outcomeId: "approved", expectedRevision: 2 });
  assert.equal(res.status, "pending_approval");
  assert.equal(res.gate, "deploy");

  const run = getRun(db, "r-1");
  assert.equal(run?.status, "paused");
  assert.equal(run?.current_state, "review"); // Cannot advance without approval

  const pending = getPendingApproval(db, "r-1");
  assert.ok(pending);
  assert.equal(pending.target_state, "deploy");

  // Now confirm approval explicitly
  const finalRes = confirmPendingApproval(db, mockDef, "r-1", pending.id, true);
  assert.equal(finalRes.status, "terminal");
  assert.equal(finalRes.nextState, "deploy");

  const completedRun = getRun(db, "r-1");
  assert.equal(completedRun?.status, "completed");
  assert.equal(completedRun?.current_state, "deploy");
});

test("stale approval cannot authorize a later visit to the same gate (ISC 5)", () => {
  const db = initDatabase(":memory:");
  startWorkflowRun(db, mockDef, mockDefYaml, "test-task", "r-1");

  // Advance intake -> review (revision 1 -> 2)
  submitOutcome(db, mockDef, { runId: "r-1", outcomeId: "valid", expectedRevision: 1 });

  // Gated transition: review -> deploy creates pending approval (revision 2)
  submitOutcome(db, mockDef, { runId: "r-1", outcomeId: "approved", expectedRevision: 2 });
  const pending = getPendingApproval(db, "r-1")!;

  // User decides not to approve yet, instead loops back: review -> intake
  // (simulate state visit changing or revision incrementing)
  db.prepare("UPDATE runs SET status = 'active' WHERE id = 'r-1'").run();
  submitOutcome(db, mockDef, { runId: "r-1", outcomeId: "retry", expectedRevision: 2 }); // now at intake, rev 3

  // Advance intake -> review again (now visit 3, rev 4)
  submitOutcome(db, mockDef, { runId: "r-1", outcomeId: "valid", expectedRevision: 3 });

  // Try to use the old approval from earlier visit:
  assert.throws(() => {
    confirmPendingApproval(db, mockDef, "r-1", pending.id, true);
  }, /Stale approval cannot authorize a different state visit/);
});

test("submitOutcome pauses run when transition max_retries limit is exceeded (P1 finding)", () => {
  const db = initDatabase(":memory:");
  const def: WorkflowDefinition = {
    name: "retry-flow",
    initial: "stepA",
    states: {
      stepA: {
        transitions: [{ outcome: "loop", to: "stepA", max_retries: 2 }, { outcome: "done", to: "end" }]
      },
      end: { terminal: true }
    }
  };
  const yaml = "name: retry-flow\ninitial: stepA\nstates:\n  stepA:\n    transitions:\n      - outcome: loop\n        to: stepA\n        max_retries: 2\n      - outcome: done\n        to: end\n  end:\n    terminal: true";
  startWorkflowRun(db, def, yaml, "t", "r-max-retries");

  // Attempt 1: loop allowed
  const res1 = submitOutcome(db, def, { runId: "r-max-retries", outcomeId: "loop", expectedRevision: 1 });
  assert.equal(res1.status, "advanced");

  // Attempt 2: loop allowed
  const res2 = submitOutcome(db, def, { runId: "r-max-retries", outcomeId: "loop", expectedRevision: 2 });
  assert.equal(res2.status, "advanced");

  // Attempt 3: limit of 2 reached -> paused!
  const res3 = submitOutcome(db, def, { runId: "r-max-retries", outcomeId: "loop", expectedRevision: 3 });
  assert.equal(res3.status, "paused");
  assert.ok(res3.reason?.includes("Loop thrash guard"));

  const run = getRun(db, "r-max-retries");
  assert.equal(run?.status, "paused");
});

test("submitOutcome succeeds when state.gate passes", () => {
  const db = initDatabase(":memory:");
  const def: WorkflowDefinition = {
    name: "state-gate-pass",
    initial: "stepA",
    states: {
      stepA: {
        gate: 'node -e "process.exit(0)"',
        transitions: [{ outcome: "next", to: "stepB" }],
      },
      stepB: { terminal: true },
    },
  };
  const yaml = "name: state-gate-pass\ninitial: stepA\nstates:\n  stepA:\n    gate: 'node -e \"process.exit(0)\"'\n    transitions:\n      - outcome: next\n        to: stepB\n  stepB:\n    terminal: true";
  startWorkflowRun(db, def, yaml, "task-1", "run-sg-pass");

  const res = submitOutcome(db, def, {
    runId: "run-sg-pass",
    outcomeId: "next",
    expectedRevision: 1,
  });

  assert.equal(res.status, "terminal");
  assert.equal(res.nextState, "stepB");
  assert.equal(res.revision, 2);

  const run = getRun(db, "run-sg-pass");
  assert.equal(run?.current_state, "stepB");
  assert.equal(run?.revision, 2);
  assert.equal(run?.status, "completed");
});

test("submitOutcome succeeds when matched.gate passes", () => {
  const db = initDatabase(":memory:");
  const def: WorkflowDefinition = {
    name: "matched-gate-pass",
    initial: "stepA",
    states: {
      stepA: {
        transitions: [
          {
            outcome: "next",
            to: "stepB",
            gate: 'node -e "process.exit(0)"',
          },
        ],
      },
      stepB: { terminal: true },
    },
  };
  const yaml = "name: matched-gate-pass\ninitial: stepA\nstates:\n  stepA:\n    transitions:\n      - outcome: next\n        to: stepB\n        gate: 'node -e \"process.exit(0)\"'\n  stepB:\n    terminal: true";
  startWorkflowRun(db, def, yaml, "task-1", "run-mg-pass");

  const res = submitOutcome(db, def, {
    runId: "run-mg-pass",
    outcomeId: "next",
    expectedRevision: 1,
  });

  assert.equal(res.status, "terminal");
  assert.equal(res.nextState, "stepB");
  assert.equal(res.revision, 2);

  const run = getRun(db, "run-mg-pass");
  assert.equal(run?.current_state, "stepB");
  assert.equal(run?.revision, 2);
  assert.equal(run?.status, "completed");
});

test("submitOutcome throws GateExecutionError when state.gate fails and run maintains original state and revision", () => {
  const db = initDatabase(":memory:");
  const def: WorkflowDefinition = {
    name: "state-gate-fail",
    initial: "stepA",
    states: {
      stepA: {
        gate: 'node -e "console.error(\'gate failed\'); process.exit(1)"',
        transitions: [{ outcome: "next", to: "stepB" }],
      },
      stepB: { terminal: true },
    },
  };
  const yaml = "name: state-gate-fail\ninitial: stepA\nstates:\n  stepA:\n    gate: 'node -e \"console.error(\\'gate failed\\'); process.exit(1)\"'\n    transitions:\n      - outcome: next\n        to: stepB\n  stepB:\n    terminal: true";
  startWorkflowRun(db, def, yaml, "task-1", "run-sg-fail");

  assert.throws(
    () => {
      submitOutcome(db, def, {
        runId: "run-sg-fail",
        outcomeId: "next",
        expectedRevision: 1,
      });
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert.equal(err.expectedExitCode, 0);
      assert.equal(err.actualExitCode, 1);
      assert.ok(err.output.includes("gate failed"));
      return true;
    }
  );

  const run = getRun(db, "run-sg-fail");
  assert.equal(run?.current_state, "stepA");
  assert.equal(run?.revision, 1);
  assert.equal(run?.status, "active");
});

test("submitOutcome throws GateExecutionError when matched.gate fails and run maintains original state and revision", () => {
  const db = initDatabase(":memory:");
  const def: WorkflowDefinition = {
    name: "matched-gate-fail",
    initial: "stepA",
    states: {
      stepA: {
        transitions: [
          {
            outcome: "next",
            to: "stepB",
            gate: { run: 'node -e "process.exit(2)"', exit_code: 0 },
          },
        ],
      },
      stepB: { terminal: true },
    },
  };
  const yaml = "name: matched-gate-fail\ninitial: stepA\nstates:\n  stepA:\n    transitions:\n      - outcome: next\n        to: stepB\n        gate:\n          run: 'node -e \"process.exit(2)\"'\n  stepB:\n    terminal: true";
  startWorkflowRun(db, def, yaml, "task-1", "run-mg-fail");

  assert.throws(
    () => {
      submitOutcome(db, def, {
        runId: "run-mg-fail",
        outcomeId: "next",
        expectedRevision: 1,
      });
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert.equal(err.expectedExitCode, 0);
      assert.equal(err.actualExitCode, 2);
      return true;
    }
  );

  const run = getRun(db, "run-mg-fail");
  assert.equal(run?.current_state, "stepA");
  assert.equal(run?.revision, 1);
  assert.equal(run?.status, "active");
});

test("submitOutcome executes state gate before matched gate", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-order-"));
  const logFile = path.join(tempDir, "order.log");

  try {
    const db = initDatabase(":memory:");
    const def: WorkflowDefinition = {
      name: "gate-order",
      initial: "stepA",
      states: {
        stepA: {
          gate: `node -e "require('node:fs').appendFileSync(process.argv[1], 'state;')"` + ` "${logFile}"`,
          transitions: [
            {
              outcome: "next",
              to: "stepB",
              gate: `node -e "require('node:fs').appendFileSync(process.argv[1], 'matched;')"` + ` "${logFile}"`,
            },
          ],
        },
        stepB: { terminal: true },
      },
    };
    const yaml = "name: gate-order\ninitial: stepA\nstates:\n  stepA:\n    transitions:\n      - outcome: next\n        to: stepB\n  stepB:\n    terminal: true";
    startWorkflowRun(db, def, yaml, "task-order", "run-order");

    const res = submitOutcome(db, def, {
      runId: "run-order",
      outcomeId: "next",
      expectedRevision: 1,
    });

    assert.equal(res.status, "terminal");
    const content = fs.readFileSync(logFile, "utf-8");
    assert.equal(content, "state;matched;");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("matched gate does not execute if state gate fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-order-fail-"));
  const logFile = path.join(tempDir, "matched.log");

  try {
    const db = initDatabase(":memory:");
    const def: WorkflowDefinition = {
      name: "gate-order-fail",
      initial: "stepA",
      states: {
        stepA: {
          gate: 'node -e "process.exit(1)"',
          transitions: [
            {
              outcome: "next",
              to: "stepB",
              gate: `node -e "require('node:fs').writeFileSync(process.argv[1], 'ran')"` + ` "${logFile}"`,
            },
          ],
        },
        stepB: { terminal: true },
      },
    };
    const yaml = "name: gate-order-fail\ninitial: stepA\nstates:\n  stepA:\n    transitions:\n      - outcome: next\n        to: stepB\n  stepB:\n    terminal: true";
    startWorkflowRun(db, def, yaml, "task-order-fail", "run-order-fail");

    assert.throws(() => {
      submitOutcome(db, def, {
        runId: "run-order-fail",
        outcomeId: "next",
        expectedRevision: 1,
      });
    }, GateExecutionError);

    assert.equal(fs.existsSync(logFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

