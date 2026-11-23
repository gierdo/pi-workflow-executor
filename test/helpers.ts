import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);

export function createMockPi() {
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

export function getActivePiNodeModules(): string | null {
  try {
    const home = process.env.HOME || "";
    const versionFile = join(home, ".pi/agent/install/current-version");
    if (existsSync(versionFile)) {
      const version = readFileSync(versionFile, "utf-8").trim();
      const nm = join(home, ".pi/agent/install/releases", version, "node_modules");
      if (existsSync(nm)) return nm;
    }
  } catch {
    // Ignore error
  }
  return null;
}

export function loadYamlParser(): (text: string) => any {
  try {
    return require("yaml").parse;
  } catch {
    const nm = getActivePiNodeModules();
    if (nm) {
      return require(join(nm, "yaml")).parse;
    }
    throw new Error("Unable to resolve YAML parser: install 'yaml' or configure active Pi runtime");
  }
}

export function resolveWorkflowsDir(): string {
  // 1. Direct package workflows directory
  const packageWorkflows = join(import.meta.dirname, "../workflows");
  if (existsSync(packageWorkflows)) return packageWorkflows;

  // 2. Global fallback
  const home = process.env.HOME || "";
  const globalWorkflows = join(home, ".pi/agent/workflows");
  if (existsSync(globalWorkflows)) return globalWorkflows;

  return join(process.cwd(), "workflows");
}
