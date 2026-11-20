import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveWorkflow,
  listWorkflows,
  getBundledWorkflowsDir,
  getPackageRoot,
  loadWorkflowConfig,
} from "../resolver.ts";

describe("resolver", () => {
  it("resolves valid package root and directories", () => {
    assert.equal(existsSync(getPackageRoot()), true);
    assert.equal(existsSync(getBundledWorkflowsDir()), true);
  });

  it("lists all 8 bundled workflows when no project workflows exist", () => {
    const emptyTemp = join(tmpdir(), `test-empty-repo-${Date.now()}`);
    mkdirSync(emptyTemp, { recursive: true });
    try {
      const workflows = listWorkflows(emptyTemp);
      const names = workflows.map((w) => w.name);
      assert.equal(names.includes("interactive-planning"), true);
      assert.equal(names.includes("task-implementation"), true);
      assert.equal(names.includes("bug-fix"), true);
      assert.equal(names.includes("feature-implementation"), true);
      assert.equal(workflows.length >= 8, true);
    } finally {
      rmSync(emptyTemp, { recursive: true, force: true });
    }
  });

  it("resolves bundled workflow definition by name", () => {
    const emptyTemp = join(tmpdir(), `test-empty-repo-${Date.now()}`);
    mkdirSync(emptyTemp, { recursive: true });
    try {
      const res = resolveWorkflow("task-implementation", emptyTemp);
      assert.notEqual(res, null);
      assert.equal(res?.source === "bundled" || res?.source === "global", true);
      assert.equal(res?.rawYaml.includes("name: task-implementation"), true);
    } finally {
      rmSync(emptyTemp, { recursive: true, force: true });
    }
  });

  it("prioritizes project-local .workflow/workflows override over bundled workflow", () => {
    const projectTemp = join(tmpdir(), `test-proj-repo-${Date.now()}`);
    const customDir = join(projectTemp, ".workflow", "workflows", "bug-fix");
    mkdirSync(customDir, { recursive: true });
    const customYaml = "name: bug-fix\nversion: 99\ndescription: Custom project-local bug fix";
    writeFileSync(join(customDir, "bug-fix.yaml"), customYaml, "utf-8");

    try {
      const res = resolveWorkflow("bug-fix", projectTemp);
      assert.notEqual(res, null);
      assert.equal(res?.source, "project");
      assert.equal(res?.rawYaml, customYaml);

      const list = listWorkflows(projectTemp);
      const bugFixItem = list.find((w) => w.name === "bug-fix");
      assert.notEqual(bugFixItem, undefined);
      assert.equal(bugFixItem?.source, "project");
      assert.equal(bugFixItem?.path, join(customDir, "bug-fix.yaml"));
    } finally {
      rmSync(projectTemp, { recursive: true, force: true });
    }
  });

  it("prioritizes project-local .pi/workflows override over bundled workflow", () => {
    const projectTemp = join(tmpdir(), `test-proj-pi-${Date.now()}`);
    const customDir = join(projectTemp, ".pi", "workflows", "refactoring");
    mkdirSync(customDir, { recursive: true });
    const customYaml = "name: refactoring\nversion: 42\ndescription: Custom pi workflow";
    writeFileSync(join(customDir, "refactoring.yaml"), customYaml, "utf-8");

    try {
      const res = resolveWorkflow("refactoring", projectTemp);
      assert.notEqual(res, null);
      assert.equal(res?.source, "project");
      assert.equal(res?.rawYaml, customYaml);
    } finally {
      rmSync(projectTemp, { recursive: true, force: true });
    }
  });

  it("disables all bundled workflows when disableBundled is configured in .workflow/config.json", () => {
    const tempDir = join(tmpdir(), `test-disable-bundled-${Date.now()}`);
    mkdirSync(join(tempDir, ".workflow"), { recursive: true });
    writeFileSync(join(tempDir, ".workflow", "config.json"), JSON.stringify({ disableBundled: true }), "utf-8");

    try {
      const list = listWorkflows(tempDir);
      assert.equal(list.some((w) => w.source === "bundled"), false);

      const res = resolveWorkflow("task-implementation", tempDir);
      if (res) {
        assert.notEqual(res.source, "bundled");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("disables all bundled workflows via PI_WORKFLOW_DISABLE_BUNDLED environment variable", () => {
    const tempDir = join(tmpdir(), `test-env-disable-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const prevEnv = process.env.PI_WORKFLOW_DISABLE_BUNDLED;
    process.env.PI_WORKFLOW_DISABLE_BUNDLED = "1";

    try {
      const config = loadWorkflowConfig(tempDir);
      assert.equal(config.disableBundled, true);

      const list = listWorkflows(tempDir);
      assert.equal(list.some((w) => w.source === "bundled"), false);
    } finally {
      if (prevEnv !== undefined) {
        process.env.PI_WORKFLOW_DISABLE_BUNDLED = prevEnv;
      } else {
        delete process.env.PI_WORKFLOW_DISABLE_BUNDLED;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("disables specific workflows when specified in disabledWorkflows array", () => {
    const tempDir = join(tmpdir(), `test-disable-specific-${Date.now()}`);
    mkdirSync(join(tempDir, ".workflow"), { recursive: true });
    writeFileSync(
      join(tempDir, ".workflow", "config.json"),
      JSON.stringify({ disabledWorkflows: ["bug-fix"] }),
      "utf-8"
    );

    try {
      const list = listWorkflows(tempDir);
      assert.equal(list.some((w) => w.name === "bug-fix"), false);
      assert.equal(resolveWorkflow("bug-fix", tempDir), null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads global config from ~/.pi/agent/extensions/workflow-executor/config.json", () => {
    const fakeHome = join(tmpdir(), `test-fake-home-${Date.now()}`);
    const globalExtDir = join(fakeHome, ".pi", "agent", "extensions", "workflow-executor");
    mkdirSync(globalExtDir, { recursive: true });
    writeFileSync(
      join(globalExtDir, "config.json"),
      JSON.stringify({ disableBundled: true, disabledWorkflows: ["custom-secret-flow"] }),
      "utf-8"
    );

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const config = loadWorkflowConfig(tmpdir());
      assert.equal(config.disableBundled, true);
      assert.equal(config.disabledWorkflows.includes("custom-secret-flow"), true);
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("resolves user-global workflows from ~/.pi/agent/skills/workflow-executor/workflows", () => {
    const fakeHome = join(tmpdir(), `test-global-skill-home-${Date.now()}`);
    const globalSkillFlowDir = join(fakeHome, ".pi", "agent", "skills", "workflow-executor", "workflows", "custom-skill-flow");
    mkdirSync(globalSkillFlowDir, { recursive: true });
    writeFileSync(
      join(globalSkillFlowDir, "custom-skill-flow.yaml"),
      "name: custom-skill-flow\nversion: 1\ndescription: Workflow in global skill dir",
      "utf-8"
    );

    try {
      const res = resolveWorkflow("custom-skill-flow", tmpdir(), fakeHome);
      assert.notEqual(res, null);
      assert.equal(res?.source, "global");
      assert.equal(res?.rawYaml.includes("name: custom-skill-flow"), true);

      const list = listWorkflows(tmpdir(), fakeHome);
      const found = list.find((w) => w.name === "custom-skill-flow");
      assert.notEqual(found, undefined);
      assert.equal(found?.source, "global");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent workflow", () => {
    assert.equal(resolveWorkflow("non-existent-workflow-xyz", tmpdir()), null);
  });
});
