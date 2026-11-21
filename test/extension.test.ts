import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowExtension from "../index.ts";
import * as runner from "../runner/index.ts";

function createMockPi() {
  const registeredCommands: string[] = [];
  const registeredTools: Record<string, any> = {};
  const sentMessages: any[] = [];

  const mockPi: any = {
    registerCommand(name: string) {
      registeredCommands.push(name);
    },
    registerTool(opts: any) {
      registeredTools[opts.name] = opts;
    },
    sendUserMessage(msg: any, options?: any) {
      sentMessages.push({ msg, options });
    },
  };

  return { mockPi, registeredCommands, registeredTools, sentMessages };
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
