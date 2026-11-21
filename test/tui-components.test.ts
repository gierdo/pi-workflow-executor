import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "ink";
import { RunList } from "../tui/components/RunList.ts";
import { GraphView } from "../tui/components/GraphView.ts";
import { ConfirmModal } from "../tui/components/ConfirmModal.ts";
import { App } from "../tui/app.ts";
import type { RunRecord, StateVisitRecord, WorkflowDefinition } from "../runner/types.ts";

function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function clean(str: string): string {
  return stripAnsi(str).replace(/[│┌┐└┘─┏┓┗┛┃━]/g, " ").replace(/\s+/g, " ").trim();
}

test("RunList renders items with status badges and cursor", () => {
  const items = [
    { id: "1", label: "wf-1-task-a", badge: "[COMPLETED]", status: "completed" },
    { id: "2", label: "wf-2-task-b", badge: "[ACTIVE]", status: "active" },
  ];
  const output = renderToString(
    React.createElement(RunList, {
      items,
      selectedIndex: 0,
      activeTab: "runs",
    })
  );

  const normalized = clean(output);
  assert.ok(normalized.includes("WORKFLOW RUNS"));
  assert.ok(normalized.includes(">"));
  assert.ok(normalized.includes("[COMPLETED]"));
  assert.ok(normalized.includes("wf-1-task-a"));
  assert.ok(normalized.includes("[ACTIVE]"));
  assert.ok(normalized.includes("wf-2-task-b"));
});

test("RunList renders friendly empty state message when empty", () => {
  const output = renderToString(
    React.createElement(RunList, {
      items: [],
      selectedIndex: 0,
      activeTab: "runs",
    })
  );

  const normalized = clean(output);
  assert.ok(normalized.includes("No workflow runs found."));
  assert.ok(normalized.includes("Press Tab to view defined workflows."));
});

test("GraphView renders graph nodes and metadata for selected run", () => {
  const run: RunRecord = {
    id: "run-test",
    task: "my-task",
    workflow: "my-wf",
    current_state: "execute",
    revision: 3,
    definition_fingerprint: "fp",
    status: "active",
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };
  const def: WorkflowDefinition = {
    name: "my-wf",
    initial: "init",
    states: {
      init: { transitions: [{ to: "execute" }] },
      execute: { transitions: [{ to: "done" }] },
      done: { terminal: true },
    },
  };
  const visits: StateVisitRecord[] = [
    { id: 1, run_id: "run-test", state_id: "init", visit_index: 1, entered_at: "2026-01-01", exited_at: "2026-01-01" },
    { id: 2, run_id: "run-test", state_id: "execute", visit_index: 2, entered_at: "2026-01-01" },
  ];

  const output = renderToString(
    React.createElement(GraphView, {
      selectedRun: run,
      definition: def,
      visits,
      activeTab: "runs",
    })
  );

  assert.ok(output.includes("Workflow: my-wf [my-task]"));
  assert.ok(output.includes("Status: [ACTIVE]"));
  assert.ok(output.includes("► execute [CURRENT]"));
  assert.ok(output.includes("✓ init"));
  assert.ok(output.includes("▼"));
});

test("GraphView slices visible lines and shows scroll badge when lines exceed viewportHeight", () => {
  const run: RunRecord = {
    id: "run-long",
    task: "long-task",
    workflow: "long-wf",
    current_state: "s1",
    revision: 1,
    definition_fingerprint: "fp",
    status: "active",
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };
  // Workflow with 5 states producing ~20+ lines
  const def: WorkflowDefinition = {
    name: "long-wf",
    initial: "s1",
    states: {
      s1: { goal: "Step 1", transitions: [{ to: "s2" }] },
      s2: { goal: "Step 2", transitions: [{ to: "s3" }] },
      s3: { goal: "Step 3", transitions: [{ to: "s4" }] },
      s4: { goal: "Step 4", transitions: [{ to: "s5" }] },
      s5: { goal: "Step 5", terminal: true },
    },
  };

  // With viewportHeight = 12, lines exceed viewportHeight
  const output = renderToString(
    React.createElement(GraphView, {
      selectedRun: run,
      definition: def,
      visits: [],
      activeTab: "runs",
      viewportHeight: 12,
      scrollOffset: 0,
    })
  );

  const normalized = clean(output);
  assert.ok(normalized.includes("[Viewing lines 1-12 of "));
  assert.ok(normalized.includes("PageUp/PageDown or [] to scroll"));
  assert.ok(normalized.includes("s1"));
  assert.ok(!normalized.includes("s4")); // s4 is beyond viewport lines

  // With scrollOffset = 10 and viewportHeight = 20
  const scrolledOutput = renderToString(
    React.createElement(GraphView, {
      selectedRun: run,
      definition: def,
      visits: [],
      activeTab: "runs",
      viewportHeight: 20,
      scrollOffset: 10,
    })
  );

  const scrolledNormalized = clean(scrolledOutput);
  assert.ok(scrolledNormalized.includes("[Viewing lines 10-29 of "));
  assert.ok(scrolledNormalized.includes("Step 4")); // s4 is now visible
  assert.ok(!scrolledNormalized.includes("Step 1")); // s1 has scrolled out of view

  // With large viewportHeight = 100, lines are fewer than viewportHeight -> badge hidden
  const tallOutput = renderToString(
    React.createElement(GraphView, {
      selectedRun: run,
      definition: def,
      visits: [],
      activeTab: "runs",
      viewportHeight: 100,
      scrollOffset: 0,
    })
  );

  const tallNormalized = clean(tallOutput);
  assert.ok(!tallNormalized.includes("PageUp/PageDown or [] to scroll"));
  assert.ok(!tallNormalized.includes("Viewing lines"));
});

test("GraphView falls back gracefully to visit history when definition is missing", () => {
  const run: RunRecord = {
    id: "run-missing-def",
    task: "legacy-task",
    workflow: "deleted-wf",
    current_state: "step2",
    revision: 2,
    definition_fingerprint: "fp",
    status: "completed",
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };
  const visits: StateVisitRecord[] = [
    { id: 1, run_id: "run-missing-def", state_id: "step1", visit_index: 1, entered_at: "2026-01-01 10:00:00", exited_at: "2026-01-01 10:05:00" },
    { id: 2, run_id: "run-missing-def", state_id: "step2", visit_index: 2, entered_at: "2026-01-01 10:05:00" },
  ];

  const output = renderToString(
    React.createElement(GraphView, {
      selectedRun: run,
      definition: null,
      visits,
      activeTab: "runs",
    })
  );

  const normalized = clean(output);
  assert.ok(normalized.includes("Workflow definition not found. Visited history:"));
  assert.ok(normalized.includes("step1"));
  assert.ok(normalized.includes("step2"));
});

test("ConfirmModal renders deletion prompt with run identifier", () => {
  const run: RunRecord = {
    id: "run-modal",
    task: "task-delete",
    workflow: "demo-wf",
    current_state: "done",
    revision: 2,
    definition_fingerprint: "fp",
    status: "completed",
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };

  const output = renderToString(
    React.createElement(ConfirmModal, { run })
  );

  assert.ok(output.includes("CONFIRM DELETION"));
  assert.ok(output.includes("demo-wf-task-delete"));
  assert.ok(output.includes("[y] to confirm"));
  assert.ok(output.includes("[n] or [Esc] to cancel"));
});

test("App root renders cleanly when projectRoot has no .workflow directory", () => {
  const output = renderToString(
    React.createElement(App, { projectRoot: "/tmp/non-existent-path-for-tui-test" })
  );

  assert.ok(output.includes("PI WORKFLOW DASHBOARD"));
  assert.ok(output.includes("No workflow runs found"));
  assert.ok(output.includes("[PageUp/PageDown/[] Scroll Graph"));
});
