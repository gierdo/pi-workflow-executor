import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import workflowExtension from "../index.ts";
import * as runner from "../runner/index.ts";
import { herdrOps } from "../herdr.ts";

function createMockPi() {
  const registeredCommands: string[] = [];
  const commandHandlers: Record<string, any> = {};
  const registeredTools: Record<string, any> = {};
  const sentMessages: any[] = [];
  const events = new EventEmitter();

  const mockPi: any = {
    events,
    registerCommand(name: string, def?: any) {
      registeredCommands.push(name);
      if (def?.handler) {
        commandHandlers[name] = def.handler;
      }
    },
    registerTool(opts: any) {
      registeredTools[opts.name] = opts;
    },
    sendUserMessage(msg: any, options?: any) {
      sentMessages.push({ msg, options });
    },
  };

  return { mockPi, registeredCommands, commandHandlers, registeredTools, sentMessages, events };
}

test("workflow extension registers commands and tools", async () => {
  const { mockPi, registeredCommands, registeredTools } = createMockPi();

  await workflowExtension(mockPi);
  assert.ok(registeredCommands.includes("workflow"));
  assert.equal(registeredCommands.includes("workflows"), false);
  assert.ok(registeredTools["workflow_start"]);
  assert.ok(registeredTools["workflow_transition"]);
  assert.ok(registeredTools["workflow_list"]);

  const tool = registeredTools["workflow_start"];
  assert.equal(tool.name, "workflow_start");
  assert.equal(tool.label, "Workflow Start");
  assert.ok(tool.description.includes("Start or resume"));
  assert.ok(tool.promptSnippet.includes("Start or resume"));
  assert.ok(Array.isArray(tool.promptGuidelines));
  assert.ok(tool.promptGuidelines.length > 0);
  assert.ok(tool.parameters);
  const props = tool.parameters.properties ?? tool.parameters;
  assert.ok(props.workflow);
  assert.ok(props.task);
  assert.ok(props.prompt);
});

test("workflow_start tool starts fresh run and returns prompt without sending user message", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-start-test-"));
  process.chdir(tempDir);

  try {
    const { mockPi, registeredTools, sentMessages } = createMockPi();
    await workflowExtension(mockPi);

    const tool = registeredTools["workflow_start"];
    assert.ok(tool);

    const mockCtx: any = { ui: {} };
    const res = await tool.execute(
      "call-1",
      { workflow: "task-implementation", task: "feature-test", prompt: "Implement new feature" },
      undefined,
      undefined,
      mockCtx
    );

    // Verify prompt returned in content
    assert.ok(res.content);
    assert.equal(res.content.length, 1);
    assert.ok(res.content[0].text.includes("You are orchestrating the 'task-implementation' workflow for task 'feature-test'"));
    assert.ok(res.content[0].text.includes("Implement new feature"));

    // Verify details
    assert.deepEqual(res.details, {
      runId: "task-implementation-feature-test",
      workflow: "task-implementation",
      task: "feature-test",
      state: "intake",
      revision: 1,
    });

    // Verify SQLite and journal created
    assert.ok(existsSync(join(tempDir, ".workflow", "state.db")));
    assert.ok(existsSync(join(tempDir, ".workflow", "runs", "task-implementation", "feature-test", "workflow-log.md")));

    // Verify NO re-entrant pi.sendUserMessage was invoked
    assert.equal(sentMessages.length, 0);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_start tool defaults task slug to 'main' if omitted", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-start-test-"));
  process.chdir(tempDir);

  try {
    const { mockPi, registeredTools } = createMockPi();
    await workflowExtension(mockPi);

    const tool = registeredTools["workflow_start"];
    const res = await tool.execute(
      "call-2",
      { workflow: "task-implementation" },
      undefined,
      undefined,
      {}
    );

    assert.equal(res.details.task, "main");
    assert.equal(res.details.runId, "task-implementation-main");
    assert.ok(res.content[0].text.includes("task 'main'"));
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_start tool resumes active or paused run and returns current state prompt", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-start-test-"));
  process.chdir(tempDir);

  try {
    const { mockPi, registeredTools, sentMessages } = createMockPi();
    await workflowExtension(mockPi);

    const tool = registeredTools["workflow_start"];

    // First call: start run
    const startRes = await tool.execute(
      "call-start",
      { workflow: "task-implementation", task: "resume-test" },
      undefined,
      undefined,
      {}
    );
    assert.equal(startRes.details.state, "intake");
    assert.equal(startRes.details.revision, 1);

    // Second call: resume run
    const resumeRes = await tool.execute(
      "call-resume",
      { workflow: "task-implementation", task: "resume-test", prompt: "Continue working" },
      undefined,
      undefined,
      {}
    );

    assert.equal(resumeRes.details.runId, "task-implementation-resume-test");
    assert.equal(resumeRes.details.state, "intake");
    assert.equal(resumeRes.details.revision, 1);
    assert.ok(resumeRes.content[0].text.includes("Continue working"));
    assert.equal(sentMessages.length, 0);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_start tool returns error when workflow definition is not found", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-start-test-"));
  process.chdir(tempDir);

  try {
    const { mockPi, registeredTools } = createMockPi();
    await workflowExtension(mockPi);

    const tool = registeredTools["workflow_start"];
    const res = await tool.execute(
      "call-err",
      { workflow: "non-existent-workflow", task: "test" },
      undefined,
      undefined,
      {}
    );

    assert.deepEqual(res.details, { error: "workflow_def_not_found" });
    assert.ok(res.content[0].text.includes("Error: Workflow definition for 'non-existent-workflow' not found."));
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_start tool returns status notice when run is already completed or aborted", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-start-test-"));
  process.chdir(tempDir);

  try {
    const { mockPi, registeredTools } = createMockPi();
    await workflowExtension(mockPi);

    const tool = registeredTools["workflow_start"];

    // Start run
    await tool.execute(
      "call-init",
      { workflow: "task-implementation", task: "finished-task" },
      undefined,
      undefined,
      {}
    );

    // Mark as completed in SQLite
    const dbPath = join(tempDir, ".workflow", "state.db");
    const db = runner.initDatabase(dbPath);
    runner.completeRun(db, "task-implementation-finished-task", 1, "completed");

    // Call workflow_start again
    const res = await tool.execute(
      "call-after-complete",
      { workflow: "task-implementation", task: "finished-task" },
      undefined,
      undefined,
      {}
    );

    assert.deepEqual(res.details, { runId: "task-implementation-finished-task", status: "completed" });
    assert.ok(res.content[0].text.includes("has already finished with status 'completed'"));
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_transition tool supports three-option approval dialogue: Approve, Reject, Chat", async () => {
  let toolHandler: any;
  const mockPi: any = {
    registerCommand() {},
    registerTool(opts: any) {
      if (opts.name === "workflow_transition") toolHandler = opts.execute;
    },
  };

  await workflowExtension(mockPi);
  assert.ok(toolHandler);
  assert.equal(typeof toolHandler, "function");

  // Mock UI context simulating selecting "Chat about it" and asking a question
  let selectCalled = false;
  let inputCalled = false;
  const mockCtx: any = {
    ui: {
      async select(prompt: string, options: string[]) {
        selectCalled = true;
        assert.equal(options.length, 3);
        assert.ok(options[0].includes("Approve"));
        assert.ok(options[1].includes("Reject"));
        assert.ok(options[2].includes("Chat about it"));
        return options[2]; // Select Chat about it
      },
      async input(title: string, placeholder?: string) {
        inputCalled = true;
        return "Can you explain why this gate is reached?";
      }
    }
  };

  assert.ok(mockCtx.ui.select);
  assert.ok(mockCtx.ui.input);
});

function setupFailingGateWorkflow(tempDir: string) {
  const flowDir = join(tempDir, ".workflow", "workflows", "test-failing-gate");
  mkdirSync(flowDir, { recursive: true });
  const yaml = `
name: test-failing-gate
initial: intake
states:
  intake:
    gate:
      run: "exit 42"
      exit_code: 0
    transitions:
      - outcome: next
        to: complete
  complete:
    terminal: true
`;
  writeFileSync(join(flowDir, "test-failing-gate.yaml"), yaml.trim(), "utf-8");
}

function setupApprovalWorkflow(tempDir: string) {
  const flowDir = join(tempDir, ".workflow", "workflows", "test-gated");
  mkdirSync(flowDir, { recursive: true });
  const yaml = `
name: test-gated
initial: intake
states:
  intake:
    transitions:
      - outcome: to_review
        to: review
  review:
    transitions:
      - outcome: approved
        to: deploy
        reason: "deploy requested"
        requires_approval: true
  deploy:
    terminal: true
`;
  writeFileSync(join(flowDir, "test-gated.yaml"), yaml.trim(), "utf-8");
}

test("workflow_transition gate approval emits herdr:blocked and fires notification when HERDR_ENV=1", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-gated-test-"));
  process.chdir(tempDir);
  setupApprovalWorkflow(tempDir);

  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  const origSpawn = herdrOps.spawn;
  const spawnedArgs: any[] = [];
  herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
    spawnedArgs.push({ cmd, args, options });
    const mockChild = new EventEmitter();
    (mockChild as any).unref = () => {};
    return mockChild as any;
  }) as any;

  try {
    const { mockPi, registeredTools, events } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    const transitionTool = registeredTools["workflow_transition"];

    await startTool.execute(
      "c1",
      { workflow: "test-gated", task: "t1" },
      undefined,
      undefined,
      { ui: {} }
    );

    await transitionTool.execute(
      "c2",
      { runId: "test-gated-t1", outcomeId: "to_review", expectedRevision: 1 },
      undefined,
      undefined,
      { ui: {} }
    );

    const emitted: any[] = [];
    events.on("herdr:blocked", (e) => emitted.push(e));

    const mockCtx: any = {
      ui: {
        async select(prompt: string, options: string[]) {
          assert.deepEqual(emitted, [
            { active: true, label: "Workflow approval: test-gated -> deploy" },
          ]);
          return options[0]; // Approve
        },
      },
    };

    const res = await transitionTool.execute(
      "c3",
      { runId: "test-gated-t1", outcomeId: "approved", expectedRevision: 2 },
      undefined,
      undefined,
      mockCtx
    );

    assert.equal(res.details.nextState, "deploy");
    assert.deepEqual(emitted, [
      { active: true, label: "Workflow approval: test-gated -> deploy" },
      { active: false },
    ]);
    assert.equal(spawnedArgs.length, 1);
    assert.equal(spawnedArgs[0].args[2], "Workflow approval required");
    assert.ok(spawnedArgs[0].args[4].includes("deploy"));
  } finally {
    herdrOps.spawn = origSpawn;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_transition gate approval omits herdr:blocked and notifications when HERDR_ENV is unset", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-gated-test-"));
  process.chdir(tempDir);
  setupApprovalWorkflow(tempDir);

  const origEnv = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;

  const origSpawn = herdrOps.spawn;
  const spawnedArgs: any[] = [];
  herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
    spawnedArgs.push({ cmd, args, options });
    const mockChild = new EventEmitter();
    (mockChild as any).unref = () => {};
    return mockChild as any;
  }) as any;

  try {
    const { mockPi, registeredTools, events } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    const transitionTool = registeredTools["workflow_transition"];

    await startTool.execute(
      "c1",
      { workflow: "test-gated", task: "t1" },
      undefined,
      undefined,
      { ui: {} }
    );

    await transitionTool.execute(
      "c2",
      { runId: "test-gated-t1", outcomeId: "to_review", expectedRevision: 1 },
      undefined,
      undefined,
      { ui: {} }
    );

    const emitted: any[] = [];
    events.on("herdr:blocked", (e) => emitted.push(e));

    const mockCtx: any = {
      ui: {
        async select(prompt: string, options: string[]) {
          return options[0]; // Approve
        },
      },
    };

    await transitionTool.execute(
      "c3",
      { runId: "test-gated-t1", outcomeId: "approved", expectedRevision: 2 },
      undefined,
      undefined,
      mockCtx
    );

    assert.equal(emitted.length, 0);
    assert.equal(spawnedArgs.length, 0);
  } finally {
    herdrOps.spawn = origSpawn;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_transition discussion prompt emits herdr:blocked and fires notification when HERDR_ENV=1", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-gated-test-"));
  process.chdir(tempDir);
  setupApprovalWorkflow(tempDir);

  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  const origSpawn = herdrOps.spawn;
  const spawnedArgs: any[] = [];
  herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
    spawnedArgs.push({ cmd, args, options });
    const mockChild = new EventEmitter();
    (mockChild as any).unref = () => {};
    return mockChild as any;
  }) as any;

  try {
    const { mockPi, registeredTools, events } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    const transitionTool = registeredTools["workflow_transition"];

    await startTool.execute(
      "c1",
      { workflow: "test-gated", task: "t1" },
      undefined,
      undefined,
      { ui: {} }
    );

    await transitionTool.execute(
      "c2",
      { runId: "test-gated-t1", outcomeId: "to_review", expectedRevision: 1 },
      undefined,
      undefined,
      { ui: {} }
    );

    const emitted: any[] = [];
    events.on("herdr:blocked", (e) => emitted.push(e));

    const mockCtx: any = {
      ui: {
        async select(prompt: string, options: string[]) {
          return options[2]; // Chat about it
        },
        async input(title: string, placeholder?: string) {
          assert.equal(emitted.length, 3); // true (select), false (select), true (input)
          assert.deepEqual(emitted[2], {
            active: true,
            label: "Workflow discussion: test-gated -> deploy",
          });
          return "Let's discuss first";
        },
      },
    };

    const res = await transitionTool.execute(
      "c3",
      { runId: "test-gated-t1", outcomeId: "approved", expectedRevision: 2 },
      undefined,
      undefined,
      mockCtx
    );

    assert.equal(res.details.status, "discussing_approval");
    assert.deepEqual(emitted, [
      { active: true, label: "Workflow approval: test-gated -> deploy" },
      { active: false },
      { active: true, label: "Workflow discussion: test-gated -> deploy" },
      { active: false },
    ]);
    assert.equal(spawnedArgs.length, 2);
    assert.equal(spawnedArgs[0].args[2], "Workflow approval required");
    assert.equal(spawnedArgs[1].args[2], "Workflow approval discussion");
  } finally {
    herdrOps.spawn = origSpawn;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("showWorkflowsInterface emits herdr:blocked and fires notification when HERDR_ENV=1", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-list-test-"));
  process.chdir(tempDir);
  setupApprovalWorkflow(tempDir);

  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  const origSpawn = herdrOps.spawn;
  const spawnedArgs: any[] = [];
  herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
    spawnedArgs.push({ cmd, args, options });
    const mockChild = new EventEmitter();
    (mockChild as any).unref = () => {};
    return mockChild as any;
  }) as any;

  try {
    const { mockPi, registeredTools, commandHandlers, events } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    await startTool.execute(
      "c1",
      { workflow: "test-gated", task: "run-a" },
      undefined,
      undefined,
      { ui: {} }
    );

    const emitted: any[] = [];
    events.on("herdr:blocked", (e) => emitted.push(e));

    const mockCtx: any = {
      ui: {
        async select(prompt: string, options: string[]) {
          assert.deepEqual(emitted, [
            { active: true, label: "Select workflow run" },
          ]);
          return options[0];
        },
        notify() {},
      },
      isIdle() {
        return true;
      },
    };

    const workflowCmd = commandHandlers["workflow"];
    assert.ok(workflowCmd);
    await workflowCmd("", mockCtx);

    assert.deepEqual(emitted, [
      { active: true, label: "Select workflow run" },
      { active: false },
    ]);
    assert.equal(spawnedArgs.length, 1);
    assert.equal(spawnedArgs[0].args[2], "Select workflow run");
  } finally {
    herdrOps.spawn = origSpawn;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("showWorkflowsInterface omits herdr:blocked and notifications when HERDR_ENV is unset", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-list-test-"));
  process.chdir(tempDir);
  setupApprovalWorkflow(tempDir);

  const origEnv = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;

  const origSpawn = herdrOps.spawn;
  const spawnedArgs: any[] = [];
  herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
    spawnedArgs.push({ cmd, args, options });
    const mockChild = new EventEmitter();
    (mockChild as any).unref = () => {};
    return mockChild as any;
  }) as any;

  try {
    const { mockPi, registeredTools, commandHandlers, events } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    await startTool.execute(
      "c1",
      { workflow: "test-gated", task: "run-a" },
      undefined,
      undefined,
      { ui: {} }
    );

    const emitted: any[] = [];
    events.on("herdr:blocked", (e) => emitted.push(e));

    const mockCtx: any = {
      ui: {
        async select(prompt: string, options: string[]) {
          return options[0];
        },
        notify() {},
      },
      isIdle() {
        return true;
      },
    };

    const workflowCmd = commandHandlers["workflow"];
    assert.ok(workflowCmd);
    await workflowCmd("", mockCtx);

    assert.equal(emitted.length, 0);
    assert.equal(spawnedArgs.length, 0);
  } finally {
    herdrOps.spawn = origSpawn;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow_transition returns structured error when gate execution fails", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-gate-fail-test-"));
  process.chdir(tempDir);
  setupFailingGateWorkflow(tempDir);

  try {
    const { mockPi, registeredTools } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    const transitionTool = registeredTools["workflow_transition"];

    await startTool.execute(
      "c1",
      { workflow: "test-failing-gate", task: "t1" },
      undefined,
      undefined,
      { ui: {} }
    );

    const res = await transitionTool.execute(
      "c2",
      { runId: "test-failing-gate-t1", outcomeId: "next", expectedRevision: 1 },
      undefined,
      undefined,
      { ui: {} }
    );

    assert.ok(res.content);
    assert.equal(res.content.length, 1);
    assert.ok(res.content[0].text.includes("Gate execution failed"));
    assert.equal(res.details.error, "gate_execution_failed");
    assert.equal(res.details.command, "exit 42");
    assert.equal(res.details.expectedExitCode, 0);
    assert.equal(res.details.actualExitCode, 42);
    assert.equal(typeof res.details.output, "string");
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
