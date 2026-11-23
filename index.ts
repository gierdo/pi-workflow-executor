import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as runner from "./runner/index.ts";
import { resolveWorkflow, listWorkflows } from "./resolver.ts";
import { slugify, parseWorkflowInvocation } from "./slug.ts";
import { isHerdrActive, notifyHerdr, withHerdrBlocked } from "./herdr.ts";

export { slugify, parseWorkflowInvocation, isHerdrActive, notifyHerdr, withHerdrBlocked };

const require = createRequire(import.meta.url);
const homeDir = process.env.HOME || "";

function getActivePiNodeModules(): string | null {
  try {
    const versionFile = join(homeDir, ".pi/agent/install/current-version");
    if (existsSync(versionFile)) {
      const version = readFileSync(versionFile, "utf-8").trim();
      const nm = join(homeDir, ".pi/agent/install/releases", version, "node_modules");
      if (existsSync(nm)) return nm;
    }
  } catch {
    // Ignore error
  }
  return null;
}

const piModules = getActivePiNodeModules();

let parseYaml: (text: string) => any;
try {
  parseYaml = require("yaml").parse;
} catch {
  if (piModules) {
    parseYaml = require(join(piModules, "yaml")).parse;
  } else {
    throw new Error("Unable to resolve YAML parser: install 'yaml' or run under active Pi runtime");
  }
}

let Type: any;
try {
  Type = (await import("typebox")).Type;
} catch {
  if (piModules) {
    try {
      Type = (await import(join(piModules, "typebox/build/index.mjs"))).Type;
    } catch {
      // Fallback below
    }
  }
  if (!Type) {
    Type = {
      Object: (props: any) => ({ type: "object", properties: props, required: Object.keys(props) }),
      String: (desc?: any) => ({ type: "string", ...desc }),
      Integer: (desc?: any) => ({ type: "integer", ...desc }),
      Optional: (schema: any) => ({ ...schema, optional: true }),
      Array: (schema: any, desc?: any) => ({ type: "array", items: schema, ...desc }),
    };
  }
}

const usage = "Usage: /workflow <name> [prompt...]";

function buildWorkflowPrompt(run: any, workflowPath: string, instructions?: string): string {
  const lines = [
    `You are orchestrating the '${run.workflow}' workflow for task '${run.task}'.`,
    `Workflow definition: Read ${workflowPath} before proceeding.`,
    `Active run ID: \`${run.id}\` | State: \`${run.current_state}\` | Revision: ${run.revision}`,
    "",
    "## Execution Instructions",
    "1. **State Goal & Scope**: Read the current state's `goal`, `consumes`, and `produces` from the YAML. Execute only the work scoped to the active state; do not perform work belonging to future states.",
    "2. **Delegation**: When a state specifies `subagent: <name>`, delegate the work to that subagent via the `subagent` tool. Pass the active state, goal, inputs, and artifact paths. Inspect delivered artifacts before transitioning.",
    "3. **Evaluate Gates**: Inspect deliverables and workspace evidence to verify whether `exit_gate` holds. Evaluate outgoing transitions top-to-bottom against their `when` conditions.",
    "4. **MANDATORY - State Transitions via Tool**:",
    "   - State ONLY advances when committed via the `workflow_transition` tool (`runId`, `outcomeId`, `expectedRevision`, `evidence`).",
    "   - Never simulate or claim transitions in chat text; call the tool.",
    "   - Autonomous transitions: for transitions without `requires_approval: true`, call `workflow_transition` autonomously and immediately continue working in the next state without stopping to ask the user.",
    "   - Gated transitions: for transitions with `requires_approval: true`, calling `workflow_transition` automatically triggers an interactive user approval dialog. Await user decision.",
    "5. **Sub-workflows**: When a state defines `invoke:`, run the child workflow. Upon reaching a terminal state, match the child outcome to the parent's transitions and call `workflow_transition`.",
    "6. **OpenSpec Conventions**: If the workflow integrates with OpenSpec (`bug-fix`, `feature-implementation`), `{task}` is the change name. Drive dedicated `openspec-*` skills and resolve paths using `openspec status --change \"${run.task}\" --json`.",
    "7. **Terminal State**: When reaching a state with `terminal: true`, the workflow is complete. Report final results and output artifact locations.",
    "8. **Parallel Execution & Herdr Worktrees**:",
    "   - Parallel execution is ONLY permitted when HERDR_ENV=1. If not running in Herdr, execute tasks sequentially in the main workspace.",
    "   - Only concurrent parallel tasks allocate worktrees. Strictly sequential steps (single-task batches or steps with no concurrent peers) execute directly with subagents in the main worktree on the base branch (or active branch) without provisioning temporary worktrees or separate branches.",
    "   - For parallel batches (concurrency ceiling default: 3, overridable by user prompt):",
    "     a. Propose a base branch name with an appropriate prefix based on workflow kind (feat/, fix/, perf/, refactor/) and confirm {prefix}/{workflow-slug} with the user.",
    "     b. Serially provision worktrees using herdr worktree create with branch {base-branch}/{task-slug}.",
    "     c. Launch worker subagents in parallel with cwd pointing to their respective worktrees and distinct child runIds.",
    "     d. Each child executes task-implementation including in-worktree review.",
    "     e. Retain worktrees until integration verification succeeds.",
    "     f. In the integration state, sequentially merge task branches into {base-branch}.",
    "     g. Upon successful verification, clean up worktrees via herdr worktree remove.",
    "   - Strict Safety: NEVER push temporary task branches or worktree branches to remote origins.",
  ];

  if (instructions && instructions.trim()) {
    lines.push("", "## User Instructions", instructions.trim());
  }

  return lines.join("\n");
}

export default async function (pi: ExtensionAPI) {
  function getDB() {
    const dbPath = join(process.cwd(), ".workflow", "state.db");
    return runner.initDatabase(dbPath);
  }

  function getJournalPath(workflow: string, task: string): string {
    return join(process.cwd(), ".workflow", "runs", workflow, task, "workflow-log.md");
  }

  async function resumeRunById(runId: string, ctx: any, instructions?: string) {
    const db = getDB();
    let run = runner.getRun(db, runId);
    if (!run) {
      ctx.ui.notify(`Run '${runId}' not found in .workflow/state.db`, "error");
      return;
    }

    const resolved = resolveWorkflow(run.workflow, process.cwd());
    if (!resolved) {
      ctx.ui.notify(`Workflow definition for '${run.workflow}' not found`, "error");
      return;
    }

    const def = parseYaml(resolved.rawYaml);
    const journalPath = getJournalPath(run.workflow, run.task);

    try {
      run = runner.resumeWorkflowRun(db, def, resolved.rawYaml, runId);
      if (run.pending_action) {
        ctx.ui.notify(
          `Unresolved external action '${run.pending_action.action}' from visit #${run.pending_action.visit_id} requires user reconciliation. Run remains paused.`,
          "warning"
        );
        return;
      }
    } catch (err) {
      ctx.ui.notify(`Cannot resume workflow: ${(err as Error).message}`, "error");
      return;
    }

    runner.syncMarkdownJournal(db, runId, journalPath);
    ctx.ui.notify(`Resumed workflow '${run.workflow}' (${run.task}) at state '${run.current_state}' [revision ${run.revision}]`, "info");

    const prompt = buildWorkflowPrompt(run, resolved.path, instructions);
    pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  async function showWorkflowsInterface(ctx: any) {
    const db = getDB();
    const runs = runner.listRuns(db);
    if (!runs || runs.length === 0) {
      ctx.ui.notify("No workflow runs found in .workflow/state.db", "info");
      return;
    }

    const options = runs.map((r: any) => {
      const badge = `[${r.status.toUpperCase()}]`;
      const pauseInfo = r.pause_reason ? ` - ${r.pause_reason}` : "";
      return `${badge} ${r.workflow} (${r.task}) - state: ${r.current_state}, rev: ${r.revision}${pauseInfo}`;
    });

    const choice = await withHerdrBlocked(
      pi.events,
      "Select workflow run",
      {
        title: "Select workflow run",
        body: "Select a workflow run to inspect or resume",
      },
      () => ctx.ui.select("Select a workflow run to inspect or resume:", options)
    );
    if (!choice) return;

    const selectedIndex = options.indexOf(choice);
    const selectedRun = runs[selectedIndex];
    if (!selectedRun) return;

    if (selectedRun.status === "completed" || selectedRun.status === "aborted") {
      const journalPath = getJournalPath(selectedRun.workflow, selectedRun.task);
      ctx.ui.notify(`Workflow '${selectedRun.workflow}' (${selectedRun.task}) is ${selectedRun.status} at state '${selectedRun.current_state}'. Journal: ${journalPath}`, "info");
      return;
    }

    // Active or paused: resume directly
    await resumeRunById(selectedRun.id, ctx);
  }

  pi.registerCommand("workflow", {
    description: "Run or resume a workflow from the workflow-executor skill (run without args to list runs)",
    getArgumentCompletions: (prefix) => {
      const input = prefix.trimStart();
      if (/\s/.test(input)) return null;
      const all = listWorkflows(process.cwd()).map((w) => w.name);
      const matches = all.filter((name) => name.startsWith(input));
      return matches.length ? matches.map((name) => ({ label: name, value: `${name} ` })) : null;
    },
    handler: async (args, ctx) => {
      if (!args || !args.trim() || args.trim() === "list") {
        await showWorkflowsInterface(ctx);
        return;
      }

      const parsed = await parseWorkflowInvocation(args, ctx, pi.events);
      if (!parsed) {
        await showWorkflowsInterface(ctx);
        return;
      }

      const { name, task, prompt: instructions } = parsed;

      const available = listWorkflows(process.cwd());
      const names = available.map((w) => w.name);

      if (!names.length) {
        ctx.ui.notify(`No workflows found in package or project`, "warning");
        return;
      }

      if (!name || !names.includes(name)) {
        const problem = name ? `Unknown workflow: ${name}\n` : "";
        ctx.ui.notify(`${problem}${usage}\nAvailable: ${names.join(", ")}`, name ? "warning" : "info");
        return;
      }

      const resolved = resolveWorkflow(name, process.cwd());
      if (!resolved) {
        ctx.ui.notify(`Cannot resolve workflow definition for '${name}'`, "error");
        return;
      }

      const def = parseYaml(resolved.rawYaml);
      const db = getDB();

      const runId = `${name}-${task || "main"}`;

      let run = runner.getRun(db, runId);
      if (run) {
        await resumeRunById(runId, ctx, instructions);
      } else {
        // Start fresh run
        try {
          run = runner.startWorkflowRun(db, def, resolved.rawYaml, task, runId);
          const journalPath = getJournalPath(name, task);
          runner.syncMarkdownJournal(db, runId, journalPath);
          ctx.ui.notify(`Started workflow '${name}' (${task}) at initial state '${run.current_state}'`, "info");
        } catch (err) {
          ctx.ui.notify(`Failed to start workflow: ${(err as Error).message}`, "error");
          return;
        }

        const prompt = buildWorkflowPrompt(run, resolved.path, instructions);
        pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      }
    },
  });

  pi.registerTool({
    name: "workflow_start",
    label: "Workflow Start",
    description: "Start or resume a transactional workflow (e.g. bug-fix, feature-implementation, task-implementation).",
    promptSnippet: "Start or resume a transactional workflow (e.g. bug-fix, feature-implementation, task-implementation).",
    promptGuidelines: ["Use workflow_start when the user asks to start, run, or resume a workflow."],
    parameters: Type.Object({
      workflow: Type.String({ description: "Name of the workflow to run (e.g. bug-fix, feature-implementation)" }),
      task: Type.Optional(Type.String({ description: "Optional kebab-case task slug or change name" })),
      prompt: Type.Optional(Type.String({ description: "Optional user context or instructions" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const resolved = resolveWorkflow(params.workflow, process.cwd());
      if (!resolved) {
        return {
          content: [{ type: "text", text: `Error: Workflow definition for '${params.workflow}' not found.` }],
          details: { error: "workflow_def_not_found" },
        };
      }

      const task = params.task ? slugify(params.task) : "main";
      const runId = `${params.workflow}-${task}`;
      const db = getDB();
      const journalPath = getJournalPath(params.workflow, task);
      let run = runner.getRun(db, runId);

      if (run) {
        if (run.status === "completed" || run.status === "aborted") {
          return {
            content: [{ type: "text", text: `Workflow '${run.workflow}' (${run.task}) has already finished with status '${run.status}'.` }],
            details: { runId: run.id, status: run.status },
          };
        }
        try {
          run = runner.resumeWorkflowRun(db, parseYaml(resolved.rawYaml), resolved.rawYaml, runId);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Cannot resume workflow: ${(err as Error).message}` }],
            details: { error: (err as Error).message },
          };
        }
        if (run.pending_action) {
          return {
            content: [{ type: "text", text: `Unresolved external action requires user reconciliation. Run remains paused.` }],
            details: { status: "pending_action", runId: run.id },
          };
        }
        runner.syncMarkdownJournal(db, runId, journalPath);
      } else {
        const def = parseYaml(resolved.rawYaml);
        try {
          run = runner.startWorkflowRun(db, def, resolved.rawYaml, task, runId);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to start workflow: ${(err as Error).message}` }],
            details: { error: (err as Error).message },
          };
        }
        runner.syncMarkdownJournal(db, runId, journalPath);
      }

      const promptText = buildWorkflowPrompt(run, resolved.path, params.prompt);
      return {
        content: [{ type: "text", text: promptText }],
        details: { runId: run.id, workflow: run.workflow, task: run.task, state: run.current_state, revision: run.revision },
      };
    },
  });

  pi.registerTool({
    name: "workflow_transition",
    label: "Workflow Transition",
    description: "Submit a workflow state outcome to advance the workflow runner.",
    parameters: Type.Object({
      runId: Type.String({ description: "Active run ID" }),
      outcomeId: Type.String({ description: "Outcome ID defined in current state transitions" }),
      expectedRevision: Type.Integer({ description: "Expected current run revision" }),
      evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence references" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const db = getDB();
      const run = runner.getRun(db, params.runId);
      if (!run) {
        return {
          content: [{ type: "text", text: `Error: Run '${params.runId}' not found.` }],
          details: { error: "run_not_found" },
        };
      }

      const resolved = resolveWorkflow(run.workflow, process.cwd());
      if (!resolved) {
        return {
          content: [{ type: "text", text: `Error: Workflow definition for '${run.workflow}' not found.` }],
          details: { error: "workflow_def_not_found" },
        };
      }

      const def = parseYaml(resolved.rawYaml);
      const journalPath = getJournalPath(run.workflow, run.task);

      try {
        const result = runner.submitOutcome(db, def, {
          runId: params.runId,
          outcomeId: params.outcomeId,
          expectedRevision: params.expectedRevision,
          evidence: params.evidence,
        });

        if (result.status === "pending_approval") {
          const pending = runner.getPendingApproval(db, params.runId);
          if (!pending) {
            throw new Error("Pending approval record not found");
          }

          const prompt = `Workflow '${run.workflow}' (${run.task}) requires approval to transition to '${result.gate}'.\nReason: ${result.reason ?? "None provided"}`;
          const options = [
            `Approve transition to '${result.gate}'`,
            `Reject transition`,
            `Chat about it (ask question or discuss)`,
          ];

          const choice = await withHerdrBlocked(
            pi.events,
            `Workflow approval: ${run.workflow} -> ${result.gate}`,
            {
              title: "Workflow approval required",
              body: `Workflow '${run.workflow}' (${run.task}) requires approval to transition to '${result.gate}'.`,
            },
            () => ctx.ui.select(prompt, options)
          );

          if (choice === options[0]) {
            // Option 1: Approved
            const finalResult = runner.confirmPendingApproval(db, def, params.runId, pending.id, true);
            runner.syncMarkdownJournal(db, params.runId, journalPath);
            return {
              content: [{
                type: "text",
                text: `Gate approved by user. Advanced to state '${finalResult.nextState}' [revision ${finalResult.revision}].`,
              }],
              details: finalResult,
            };
          } else if (choice === options[2]) {
            // Option 3: Chat about it
            const userPrompt = await withHerdrBlocked(
              pi.events,
              `Workflow discussion: ${run.workflow} -> ${result.gate}`,
              {
                title: "Workflow approval discussion",
                body: `Provide feedback or ask questions before deciding on approval for '${result.gate}'.`,
              },
              () =>
                ctx.ui.input(
                  "Ask a question or provide feedback before deciding:",
                  "What would you like to know or adjust before approving?"
                )
            );

            if (userPrompt && userPrompt.trim()) {
              return {
                content: [{
                  type: "text",
                  text: `The user requested to discuss this transition before deciding on approval.\n\nUser question / prompt:\n"${userPrompt.trim()}"\n\nINSTRUCTIONS FOR AGENT:\n1. Answer the user's question thoroughly and directly in your response.\n2. Once you have answered, call the \`workflow_transition\` tool again with the exact same parameters:\n   - runId: "${params.runId}"\n   - outcomeId: "${params.outcomeId}"\n   - expectedRevision: ${params.expectedRevision}\n   This will immediately display the approval dialogue to the user again with the latest context.`,
                }],
                details: { status: "discussing_approval", gate: result.gate, userPrompt: userPrompt.trim() },
              };
            }

            return {
              content: [{
                type: "text",
                text: `Approval discussion was cancelled without input. The workflow remains paused in state '${run.current_state}' awaiting decision on transition to '${result.gate}'.\nCall \`workflow_transition\` again when ready to present the approval dialogue.`,
              }],
              details: { status: "pending_approval_cancelled", gate: result.gate },
            };
          } else {
            // Option 2: Rejected (or dismissed/cancelled)
            const finalResult = runner.confirmPendingApproval(db, def, params.runId, pending.id, false);
            runner.syncMarkdownJournal(db, params.runId, journalPath);
            return {
              content: [{
                type: "text",
                text: `Gate was rejected by user. Workflow remains in state '${run.current_state}'.`,
              }],
              details: finalResult,
            };
          }
        }

        // Auto-advanced or terminal
        runner.syncMarkdownJournal(db, params.runId, journalPath);
        return {
          content: [{
            type: "text",
            text: `Workflow transitioned: status=${result.status}, state=${result.nextState}, revision=${result.revision}`,
          }],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Transition failed: ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
    },
  });

  pi.registerTool({
    name: "workflow_list",
    label: "Workflow List",
    description: "List currently active, paused, or completed workflow runs from .workflow/state.db",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Optional status filter: active, paused, completed, aborted" })),
    }),
    async execute(toolCallId, params) {
      const db = getDB();
      const runs = runner.listRuns(db, params?.status);
      if (!runs || runs.length === 0) {
        return {
          content: [{ type: "text", text: "No workflow runs found." }],
          details: { runs: [] },
        };
      }

      const summary = runs.map((r: any) =>
        `- \`${r.id}\` [${r.status.toUpperCase()}] workflow: ${r.workflow}, task: ${r.task}, state: ${r.current_state}, rev: ${r.revision}`
      ).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { runs },
      };
    },
  });
}
