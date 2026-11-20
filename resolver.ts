import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export interface WorkflowSource {
  name: string;
  path: string;
  source: "project" | "global" | "bundled";
}

export interface WorkflowConfig {
  disableBundled: boolean;
  disabledWorkflows: string[];
}

export function getPackageRoot(): string {
  return packageRoot;
}

export function getBundledWorkflowsDir(): string {
  return join(packageRoot, "workflows");
}

export function getGlobalWorkflowsDir(home: string = process.env.HOME || ""): string {
  return join(home, ".pi", "agent", "workflows");
}

function applyConfigObject(target: any, config: WorkflowConfig) {
  if (!target || typeof target !== "object") return;
  const cfg = target["workflow-executor"] || target["workflow"] || target;
  if (cfg.disableBundled === true || cfg.disableBundledWorkflows === true) {
    config.disableBundled = true;
  }
  if (Array.isArray(cfg.disabledWorkflows)) {
    config.disabledWorkflows.push(...cfg.disabledWorkflows);
  }
}

/**
 * Loads workflow configuration from:
 * 1. Environment variable (PI_WORKFLOW_DISABLE_BUNDLED=1 or WORKFLOW_DISABLE_BUNDLED=1)
 * 2. Global extension config:
 *    - ~/.pi/agent/extensions/workflow-executor/config.json
 * 3. Settings files (~/.pi/agent/settings.json, <cwd>/.pi/settings.json)
 * 4. Project-level config:
 *    - <cwd>/.pi/extensions/workflow-executor/config.json
 *    - <cwd>/.workflow/config.json
 */
export function loadWorkflowConfig(
  cwd: string = process.cwd(),
  home: string = process.env.HOME || ""
): WorkflowConfig {
  const config: WorkflowConfig = {
    disableBundled: false,
    disabledWorkflows: [],
  };

  // 1. Environment variables
  if (process.env.PI_WORKFLOW_DISABLE_BUNDLED === "1" || process.env.WORKFLOW_DISABLE_BUNDLED === "1") {
    config.disableBundled = true;
  }

  // 2. Candidate configuration files (evaluated in order from global to project-local)
  const configCandidates = [
    // Global extension config
    join(home, ".pi", "agent", "extensions", "workflow-executor", "config.json"),
    join(home, ".pi", "agent", "settings.json"),
    // Project-local configs
    join(cwd, ".pi", "settings.json"),
    join(cwd, ".pi", "extensions", "workflow-executor", "config.json"),
    join(cwd, ".workflow", "config.json"),
  ];

  for (const cPath of configCandidates) {
    if (existsSync(cPath)) {
      try {
        const data = JSON.parse(readFileSync(cPath, "utf-8"));
        applyConfigObject(data, config);
      } catch {
        // Ignore JSON parse errors
      }
    }
  }

  // Deduplicate disabled workflows
  config.disabledWorkflows = Array.from(new Set(config.disabledWorkflows));

  return config;
}

/**
 * Resolves a workflow definition file path and content.
 * Checks in strict precedence order:
 * 1. <cwd>/.workflow/workflows/<name>/<name>.yaml (project-local override)
 * 2. <cwd>/.pi/workflows/<name>/<name>.yaml       (project-local override)
 * 3. ~/.pi/agent/workflows/<name>/<name>.yaml     (user-global override)
 * 4. <packageRoot>/workflows/<name>/<name>.yaml   (bundled fallback, unless disabled)
 */
export function resolveWorkflow(
  name: string,
  cwd: string = process.cwd(),
  home: string = process.env.HOME || ""
): { path: string; rawYaml: string; source: "project" | "global" | "bundled" } | null {
  const config = loadWorkflowConfig(cwd, home);

  if (config.disabledWorkflows.includes(name)) {
    return null;
  }

  const candidates: Array<{ path: string; source: "project" | "global" | "bundled" }> = [
    { path: join(cwd, ".workflow", "workflows", name, `${name}.yaml`), source: "project" },
    { path: join(cwd, ".pi", "workflows", name, `${name}.yaml`), source: "project" },
    { path: join(home, ".pi", "agent", "workflows", name, `${name}.yaml`), source: "global" },
    { path: join(home, ".pi", "agent", "skills", "workflow-executor", "workflows", name, `${name}.yaml`), source: "global" },
  ];

  if (!config.disableBundled) {
    candidates.push({ path: join(packageRoot, "workflows", name, `${name}.yaml`), source: "bundled" });
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      try {
        const rawYaml = readFileSync(candidate.path, "utf-8");
        return { path: candidate.path, rawYaml, source: candidate.source };
      } catch {
        // Continue searching
      }
    }
  }

  return null;
}

/**
 * Lists all available workflow names and sources.
 * Precedence: project-local > user-global > bundled.
 */
export function listWorkflows(
  cwd: string = process.cwd(),
  home: string = process.env.HOME || ""
): WorkflowSource[] {
  const config = loadWorkflowConfig(cwd, home);
  const map = new Map<string, WorkflowSource>();

  // 1. Bundled workflows (lowest priority base, skipped if disabled)
  if (!config.disableBundled) {
    const bundledDir = getBundledWorkflowsDir();
    if (existsSync(bundledDir)) {
      try {
        const entries = readdirSync(bundledDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
            const yamlPath = join(bundledDir, entry.name, `${entry.name}.yaml`);
            if (statSync(yamlPath, { throwIfNoEntry: false })?.isFile()) {
              map.set(entry.name, { name: entry.name, path: yamlPath, source: "bundled" });
            }
          }
        }
      } catch {
        // Ignore directory scan errors
      }
    }
  }

  // 2. User-global workflows (~/.pi/agent/workflows and ~/.pi/agent/skills/workflow-executor/workflows)
  const globalDirs = [
    getGlobalWorkflowsDir(home),
    join(home, ".pi", "agent", "skills", "workflow-executor", "workflows"),
  ];
  for (const globalDir of globalDirs) {
    if (existsSync(globalDir)) {
      try {
        const entries = readdirSync(globalDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
            const yamlPath = join(globalDir, entry.name, `${entry.name}.yaml`);
            if (statSync(yamlPath, { throwIfNoEntry: false })?.isFile()) {
              map.set(entry.name, { name: entry.name, path: yamlPath, source: "global" });
            }
          }
        }
      } catch {
        // Ignore directory scan errors
      }
    }
  }

  // 3. Project-local workflows (.pi/workflows and .workflow/workflows) (highest priority)
  const projectDirs = [
    join(cwd, ".pi", "workflows"),
    join(cwd, ".workflow", "workflows"),
  ];

  for (const dir of projectDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
            const yamlPath = join(dir, entry.name, `${entry.name}.yaml`);
            if (statSync(yamlPath, { throwIfNoEntry: false })?.isFile()) {
              map.set(entry.name, { name: entry.name, path: yamlPath, source: "project" });
            }
          }
        }
      } catch {
        // Ignore directory scan errors
      }
    }
  }

  // Filter out any explicitly disabled workflows
  for (const disabled of config.disabledWorkflows) {
    map.delete(disabled);
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}
