import test from "node:test";
import assert from "node:assert/strict";
import {
  computeGraphNodes,
  computeGraphEdges,
  buildGraphModel,
} from "../tui/graph.ts";
import type { WorkflowDefinition } from "../runner/types.ts";

const sampleWorkflow: WorkflowDefinition = {
  name: "sample-workflow",
  initial: "intake",
  states: {
    intake: {
      goal: "Check task specification",
      transitions: [
        { to: "blocked", outcome: "under_specified" },
        { to: "implement", outcome: "context_ready" },
      ],
    },
    implement: {
      goal: "Write code and tests",
      transitions: [
        { to: "verify", outcome: "implemented" },
      ],
    },
    verify: {
      goal: "Run test suite",
      transitions: [
        { to: "report", outcome: "tests_passed" },
        { to: "implement", outcome: "tests_failed" }, // cycle / loop
      ],
    },
    report: {
      goal: "Report summary",
      transitions: [
        { to: "done" },
      ],
    },
    blocked: {
      goal: "Under-specified task returned to planner",
      terminal: true,
    },
    done: {
      goal: "Finished task execution",
      terminal: true,
    },
  },
};

test("computeGraphNodes assigns level 0 to initial state and BFS depths to children", () => {
  const nodes = computeGraphNodes(sampleWorkflow, ["intake", "implement"], "implement");

  const intakeNode = nodes.find((n) => n.id === "intake");
  assert.ok(intakeNode);
  assert.equal(intakeNode.level, 0);
  assert.equal(intakeNode.visited, true);
  assert.equal(intakeNode.active, false);

  const implementNode = nodes.find((n) => n.id === "implement");
  assert.ok(implementNode);
  assert.equal(implementNode.level, 1);
  assert.equal(implementNode.visited, true);
  assert.equal(implementNode.active, true);

  const blockedNode = nodes.find((n) => n.id === "blocked");
  assert.ok(blockedNode);
  assert.equal(blockedNode.level, 1);
  assert.equal(blockedNode.visited, false);

  const verifyNode = nodes.find((n) => n.id === "verify");
  assert.ok(verifyNode);
  assert.equal(verifyNode.level, 2);

  const reportNode = nodes.find((n) => n.id === "report");
  assert.ok(reportNode);
  assert.equal(reportNode.level, 3);

  const doneNode = nodes.find((n) => n.id === "done");
  assert.ok(doneNode);
  assert.equal(doneNode.level, 4);
});

test("computeGraphEdges extracts transitions with outcomes", () => {
  const edges = computeGraphEdges(sampleWorkflow);
  assert.ok(edges.some((e) => e.from === "intake" && e.to === "implement" && e.outcome === "context_ready"));
  assert.ok(edges.some((e) => e.from === "intake" && e.to === "blocked" && e.outcome === "under_specified"));
  assert.ok(edges.some((e) => e.from === "verify" && e.to === "implement" && e.outcome === "tests_failed"));
});

test("buildGraphModel formats boxes and arrows correctly with active/visited flags", () => {
  const lines = buildGraphModel(sampleWorkflow, ["intake"], "implement");
  const fullText = lines.join("\n");

  // Box drawing characters
  assert.ok(fullText.includes("╭───"));
  assert.ok(fullText.includes("│"));
  assert.ok(fullText.includes("╰───"));

  // Directed arrow
  assert.ok(fullText.includes("──►"));

  // Visited state has ✓
  assert.ok(fullText.includes("✓ intake"));

  // Active state has ► and [CURRENT]
  assert.ok(fullText.includes("► implement [CURRENT]"));

  // Terminal state marked
  assert.ok(fullText.includes("blocked [TERMINAL]"));
});

test("buildGraphModel handles cycles and empty workflows gracefully", () => {
  const emptyLines = buildGraphModel({ name: "empty", initial: "none", states: {} });
  assert.equal(emptyLines[0], "(empty workflow definition)");

  // Cyclic workflow with 2 mutual states
  const cyclicWf: WorkflowDefinition = {
    name: "cycle",
    initial: "a",
    states: {
      a: { transitions: [{ to: "b" }] },
      b: { transitions: [{ to: "a" }] },
    },
  };
  const nodes = computeGraphNodes(cyclicWf);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]?.id, "a");
  assert.equal(nodes[0]?.level, 0);
  assert.equal(nodes[1]?.id, "b");
  assert.equal(nodes[1]?.level, 1);

  const lines = buildGraphModel(cyclicWf);
  assert.ok(lines.join("\n").includes("▼"));
  assert.ok(lines.join("\n").includes("──► a"));
});

test("buildGraphModel renders sequential trunks, entry stems, and loop rails", () => {
  const lines = buildGraphModel(sampleWorkflow, ["intake"], "implement");
  const fullText = lines.join("\n");

  // Box borders contain entry stems (┴) and exit stems (┬)
  assert.ok(fullText.includes("┴"));
  assert.ok(fullText.includes("┬"));

  // Sequential transitions output centered vertical trunk with arrow into next box
  assert.ok(fullText.includes("▼"));
  assert.ok(fullText.includes("│ [implemented]"));
  assert.ok(fullText.includes("│ [under_specified]"));
  assert.ok(fullText.includes("│ [tests_passed]"));

  // Forward jumps and backward loops output margin rail lines
  assert.ok(fullText.includes("╭── [context_ready]"));
  assert.ok(fullText.includes("╰──► implement"));
  assert.ok(fullText.includes("╭── [tests_failed]"));
});
