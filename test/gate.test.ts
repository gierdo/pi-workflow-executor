import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { normalizeGate, executeGate } from "../runner/gate.ts";
import { GateExecutionError } from "../runner/types.ts";

test("normalizeGate handles string shorthand with defaults", () => {
  const norm = normalizeGate("echo test");
  assert.deepEqual(norm, {
    run: "echo test",
    exit_code: 0,
    timeout: 30_000,
  });
});

test("normalizeGate handles object format with defaults", () => {
  const norm = normalizeGate({ run: "cargo test" });
  assert.deepEqual(norm, {
    run: "cargo test",
    exit_code: 0,
    timeout: 30_000,
  });
});

test("normalizeGate preserves custom exit_code and timeout", () => {
  const norm = normalizeGate({
    run: "pytest",
    exit_code: 2,
    timeout: 5_000,
  });
  assert.deepEqual(norm, {
    run: "pytest",
    exit_code: 2,
    timeout: 5_000,
  });
});

test("executeGate succeeds on exit code 0", () => {
  const ctx = {
    runId: "run-1",
    task: "task-1",
    state: "state-1",
  };

  // String shorthand
  assert.doesNotThrow(() => {
    executeGate('node -e "process.exit(0)"', ctx);
  });

  // Object format
  assert.doesNotThrow(() => {
    executeGate({ run: 'node -e "process.exit(0)"', exit_code: 0 }, ctx);
  });
});

test("executeGate throws GateExecutionError on exit code mismatch", () => {
  const ctx = {
    runId: "run-1",
    task: "task-1",
    state: "state-1",
  };

  assert.throws(
    () => {
      executeGate('node -e "console.error(\'failed task\'); process.exit(1)"', ctx);
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert.equal(err.command, 'node -e "console.error(\'failed task\'); process.exit(1)"');
      assert.equal(err.expectedExitCode, 0);
      assert.equal(err.actualExitCode, 1);
      assert.match(err.output, /failed task/);
      assert.match(err.message, /expected exit code 0, received 1/);
      return true;
    }
  );
});

test("executeGate handles custom expected exit_code", () => {
  const ctx = {
    runId: "run-1",
    task: "task-1",
    state: "state-1",
  };

  // Process exits 2, expected 2 -> should succeed
  assert.doesNotThrow(() => {
    executeGate({ run: 'node -e "process.exit(2)"', exit_code: 2 }, ctx);
  });

  // Process exits 0, expected 2 -> should fail
  assert.throws(
    () => {
      executeGate({ run: 'node -e "process.exit(0)"', exit_code: 2 }, ctx);
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert.equal(err.expectedExitCode, 2);
      assert.equal(err.actualExitCode, 0);
      return true;
    }
  );
});

test("executeGate passes WORKFLOW_* env vars to child process", () => {
  const ctx = {
    runId: "run-xyz-123",
    task: "deploy-pipeline",
    state: "verify-production",
    outcome: "staging-approved",
  };

  // Check all env vars are passed
  const checkCmd =
    'node -e "if (process.env.WORKFLOW_RUN_ID !== \'run-xyz-123\' || ' +
    'process.env.WORKFLOW_TASK !== \'deploy-pipeline\' || ' +
    'process.env.WORKFLOW_STATE !== \'verify-production\' || ' +
    'process.env.WORKFLOW_OUTCOME !== \'staging-approved\') process.exit(1);"';

  assert.doesNotThrow(() => {
    executeGate(checkCmd, ctx);
  });

  // Check default outcome fallback to empty string
  const checkEmptyOutcomeCmd =
    'node -e "if (process.env.WORKFLOW_OUTCOME !== \'\') process.exit(1);"';

  assert.doesNotThrow(() => {
    executeGate(checkEmptyOutcomeCmd, {
      runId: "run-abc",
      task: "task-def",
      state: "state-ghi",
    });
  });
});

test("executeGate honors ctx.cwd", () => {
  const tmpDir = os.tmpdir();
  const checkCwdCmd =
    `node -e "const fs = require('fs'); const realTmp = fs.realpathSync('${tmpDir.replace(/\\/g, "\\\\")}'); const realCwd = fs.realpathSync(process.cwd()); if (realTmp !== realCwd) process.exit(1);"`;

  assert.doesNotThrow(() => {
    executeGate(checkCwdCmd, {
      runId: "run-1",
      task: "task-1",
      state: "state-1",
      cwd: tmpDir,
    });
  });
});

test("executeGate throws on timeout with informative error", () => {
  const ctx = {
    runId: "run-1",
    task: "task-1",
    state: "state-1",
  };

  assert.throws(
    () => {
      executeGate(
        {
          run: 'node -e "setTimeout(() => {}, 2000)"',
          timeout: 50,
        },
        ctx
      );
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert.match(err.message, /Gate execution failed:.*(ETIMEDOUT|timed out)/i);
      return true;
    }
  );
});

test("executeGate truncates large output to last 50 lines and max 4096 characters", () => {
  const ctx = {
    runId: "run-1",
    task: "task-1",
    state: "state-1",
  };

  // Test line truncation: generate 100 lines
  assert.throws(
    () => {
      executeGate(
        'node -e "for(let i = 1; i <= 100; i++) console.log(\'line-\' + i); process.exit(1);"',
        ctx
      );
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      const lines = err.output.split("\n");
      assert.equal(lines.length, 50);
      assert.equal(lines[0], "line-51");
      assert.equal(lines[lines.length - 1], "line-100");
      return true;
    }
  );

  // Test byte / char truncation: single line of 8000 characters
  assert.throws(
    () => {
      executeGate(
        'node -e "console.log(\'A\'.repeat(8000)); process.exit(1);"',
        ctx
      );
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert(err.output.length <= 4096);
      assert.equal(err.output.length, 4096);
      return true;
    }
  );

  // Test combining stdout and stderr
  assert.throws(
    () => {
      executeGate(
        'node -e "console.log(\'standard output\'); console.error(\'error output\'); process.exit(1);"',
        ctx
      );
    },
    (err: unknown) => {
      assert(err instanceof GateExecutionError);
      assert.match(err.output, /standard output/);
      assert.match(err.output, /error output/);
      return true;
    }
  );
});
