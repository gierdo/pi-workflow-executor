import test from "node:test";
import assert from "node:assert/strict";
import { validateDefinition, computeFingerprint, validateGate } from "../runner/validator.ts";
import type { WorkflowDefinition } from "../runner/types.ts";

test("computeFingerprint produces deterministic sha256 hex string", () => {
  const hash1 = computeFingerprint("name: test\ninitial: start");
  const hash2 = computeFingerprint("name: test\ninitial: start");
  const hash3 = computeFingerprint("name: test\ninitial: other");
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
  assert.equal(hash1.length, 64);
});

test("computeFingerprint normalizes CRLF and LF line endings to identical hash", () => {
  const lf = "name: test\ninitial: start\nstates:\n  start:\n    terminal: true\n";
  const crlf = "name: test\r\ninitial: start\r\nstates:\r\n  start:\r\n    terminal: true\r\n";
  assert.equal(computeFingerprint(crlf), computeFingerprint(lf));
});

test("validateDefinition accepts valid workflow definition", () => {
  const def: WorkflowDefinition = {
    name: "simple-flow",
    initial: "step1",
    states: {
      step1: {
        goal: "Do step 1",
        transitions: [
          { outcome: "done", to: "completed", reason: "step 1 finished" }
        ]
      },
      completed: {
        terminal: true,
        goal: "Finished"
      }
    }
  };

  const res = validateDefinition(def);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test("validateDefinition rejects missing initial state", () => {
  const def: WorkflowDefinition = {
    name: "invalid-flow",
    initial: "non_existent",
    states: {
      step1: {
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };

  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("Initial state 'non_existent' is not declared")));
});

test("validateDefinition rejects dangling transition target", () => {
  const def: WorkflowDefinition = {
    name: "invalid-target",
    initial: "step1",
    states: {
      step1: {
        transitions: [{ to: "ghost_state" }]
      },
      done: { terminal: true }
    }
  };

  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("targets unknown state 'ghost_state'")));
});

test("validateDefinition rejects non-terminal state without transitions", () => {
  const def: WorkflowDefinition = {
    name: "no-transitions",
    initial: "step1",
    states: {
      step1: {},
      done: { terminal: true }
    }
  };

  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("Non-terminal state 'step1' has no transitions")));
});

test("validateDefinition rejects definition without any terminal state", () => {
  const def: WorkflowDefinition = {
    name: "no-terminal",
    initial: "loop",
    states: {
      loop: {
        transitions: [{ to: "loop" }]
      }
    }
  };

  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("at least one terminal state")));
});

test("validateDefinition accepts valid subagent string and object", () => {
  const defString: WorkflowDefinition = {
    name: "subagent-str",
    initial: "s1",
    states: {
      s1: {
        subagent: "reviewer",
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(defString).valid, true);

  const defObj: WorkflowDefinition = {
    name: "subagent-obj",
    initial: "s1",
    states: {
      s1: {
        subagent: { agent: "worker", skills: "software-engineering" },
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(defObj).valid, true);
});

test("validateDefinition rejects invalid subagent declaration", () => {
  const defEmpty: WorkflowDefinition = {
    name: "subagent-empty",
    initial: "s1",
    states: {
      s1: {
        subagent: "   ",
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resEmpty = validateDefinition(defEmpty);
  assert.equal(resEmpty.valid, false);
  assert.ok(resEmpty.errors.some(e => e.includes("empty 'subagent' name")));

  const defMissingAgent: WorkflowDefinition = {
    name: "subagent-bad-obj",
    initial: "s1",
    states: {
      s1: {
        subagent: { skills: "foo" } as any,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resMissing = validateDefinition(defMissingAgent);
  assert.equal(resMissing.valid, false);
  assert.ok(resMissing.errors.some(e => e.includes("missing required 'agent' name")));
});

test("validateDefinition accepts valid concurrency and rejects invalid concurrency (ISC 13)", () => {
  const validDef: WorkflowDefinition = {
    name: "concurrency-valid",
    concurrency: 3,
    initial: "s1",
    states: {
      s1: {
        concurrency: 2,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(validDef).valid, true);

  const invalidDef: WorkflowDefinition = {
    name: "concurrency-invalid",
    concurrency: 0,
    initial: "s1",
    states: {
      s1: {
        concurrency: -1,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const res = validateDefinition(invalidDef);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("Workflow 'concurrency' must be an integer >= 1")));
  assert.ok(res.errors.some(e => e.includes("State 's1' 'concurrency' must be an integer >= 1")));
});

test("validateDefinition accepts valid string gate and valid object gate on state", () => {
  const defString: WorkflowDefinition = {
    name: "state-gate-str",
    initial: "s1",
    states: {
      s1: {
        gate: "npm test",
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(defString).valid, true);

  const defObj: WorkflowDefinition = {
    name: "state-gate-obj",
    initial: "s1",
    states: {
      s1: {
        gate: { run: "npm test", exit_code: 0, timeout: 30 },
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(defObj).valid, true);
});

test("validateDefinition accepts valid string gate and valid object gate on transition", () => {
  const defString: WorkflowDefinition = {
    name: "tr-gate-str",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: "npm test" }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(defString).valid, true);

  const defObj: WorkflowDefinition = {
    name: "tr-gate-obj",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: { run: "npm test", exit_code: 0, timeout: 60 } }]
      },
      done: { terminal: true }
    }
  };
  assert.equal(validateDefinition(defObj).valid, true);
});

test("validateDefinition rejects empty string gate", () => {
  const defState: WorkflowDefinition = {
    name: "empty-state-gate",
    initial: "s1",
    states: {
      s1: {
        gate: "   ",
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resState = validateDefinition(defState);
  assert.equal(resState.valid, false);
  assert.ok(resState.errors.some(e => e.includes("State 's1' has empty 'gate' command string")));

  const defTr: WorkflowDefinition = {
    name: "empty-tr-gate",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: "" }]
      },
      done: { terminal: true }
    }
  };
  const resTr = validateDefinition(defTr);
  assert.equal(resTr.valid, false);
  assert.ok(resTr.errors.some(e => e.includes("State 's1' transition #1 has empty 'gate' command string")));
});

test("validateDefinition rejects gate object missing run property or empty run", () => {
  const defMissingRun: WorkflowDefinition = {
    name: "missing-run",
    initial: "s1",
    states: {
      s1: {
        gate: { exit_code: 0 } as any,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resMissing = validateDefinition(defMissingRun);
  assert.equal(resMissing.valid, false);
  assert.ok(resMissing.errors.some(e => e.includes("State 's1' 'gate' object requires a non-empty string 'run' property")));

  const defEmptyRun: WorkflowDefinition = {
    name: "empty-run",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: { run: "  " } }]
      },
      done: { terminal: true }
    }
  };
  const resEmpty = validateDefinition(defEmptyRun);
  assert.equal(resEmpty.valid, false);
  assert.ok(resEmpty.errors.some(e => e.includes("State 's1' transition #1 'gate' object requires a non-empty string 'run' property")));
});

test("validateDefinition rejects non-integer exit_code and timeout < 1", () => {
  const defBadExitCode: WorkflowDefinition = {
    name: "bad-exit-code",
    initial: "s1",
    states: {
      s1: {
        gate: { run: "test", exit_code: 1.5 } as any,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resBadExit = validateDefinition(defBadExitCode);
  assert.equal(resBadExit.valid, false);
  assert.ok(resBadExit.errors.some(e => e.includes("State 's1' 'gate.exit_code' must be an integer")));

  const defBadTimeoutZero: WorkflowDefinition = {
    name: "bad-timeout-zero",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: { run: "test", timeout: 0 } }]
      },
      done: { terminal: true }
    }
  };
  const resBadTimeoutZero = validateDefinition(defBadTimeoutZero);
  assert.equal(resBadTimeoutZero.valid, false);
  assert.ok(resBadTimeoutZero.errors.some(e => e.includes("State 's1' transition #1 'gate.timeout' must be an integer >= 1")));

  const defBadTimeoutFloat: WorkflowDefinition = {
    name: "bad-timeout-float",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: { run: "test", timeout: 2.5 } }]
      },
      done: { terminal: true }
    }
  };
  const resBadTimeoutFloat = validateDefinition(defBadTimeoutFloat);
  assert.equal(resBadTimeoutFloat.valid, false);
  assert.ok(resBadTimeoutFloat.errors.some(e => e.includes("State 's1' transition #1 'gate.timeout' must be an integer >= 1")));
});

test("validateDefinition rejects invalid types (boolean, array, number)", () => {
  const defBool: WorkflowDefinition = {
    name: "bool-gate",
    initial: "s1",
    states: {
      s1: {
        gate: true as any,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resBool = validateDefinition(defBool);
  assert.equal(resBool.valid, false);
  assert.ok(resBool.errors.some(e => e.includes("State 's1' 'gate' must be a string or object")));

  const defArray: WorkflowDefinition = {
    name: "array-gate",
    initial: "s1",
    states: {
      s1: {
        gate: ["echo hello"] as any,
        transitions: [{ to: "done" }]
      },
      done: { terminal: true }
    }
  };
  const resArray = validateDefinition(defArray);
  assert.equal(resArray.valid, false);
  assert.ok(resArray.errors.some(e => e.includes("State 's1' 'gate' must be a string or object")));

  const defNum: WorkflowDefinition = {
    name: "num-gate",
    initial: "s1",
    states: {
      s1: {
        transitions: [{ to: "done", gate: 42 as any }]
      },
      done: { terminal: true }
    }
  };
  const resNum = validateDefinition(defNum);
  assert.equal(resNum.valid, false);
  assert.ok(resNum.errors.some(e => e.includes("State 's1' transition #1 'gate' must be a string or object")));
});

