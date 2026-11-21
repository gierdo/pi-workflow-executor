# Workflow Executor for Pi

A transactional state-machine engine and declarative workflow runner for the [Pi coding agent](https://pi.dev).

It provides an authoritative SQLite state store (`.workflow/state.db`), structured outcome transitions, interactive user approval gates, refinement loops with thrash guards, and automatic one-way Markdown journal generation.

---

## Installation

Install directly into Pi from git:

```bash
pi install git:github.com/gierdo/pi-workflow-executor
```

Or install from a local path:

```bash
pi install ./path/to/pi-workflow-executor
```

Pi discovers the extension and bundled workflows automatically.

---

## Usage

### Starting a Workflow

Run the `/workflow` slash command followed by the workflow name and your natural prompt:

```text
/workflow <name> [prompt...]
```

Examples:

```text
/workflow interactive-planning design oauth2 authentication with refresh tokens
/workflow bug-fix fix connection timeout in postgres pool
/workflow task-implementation implement auth middleware tests
```

- `<name>`: The identifier of the workflow to run (e.g. `interactive-planning`, `bug-fix`, or a custom workflow).
- `[prompt...]`: Your instructions in natural language. The extension automatically normalizes the prompt into a clean kebab-case task slug (e.g. `design-oauth2-authentication-with`) and presents an interactive input dialog pre-filled with the slug. Press **Enter** to accept it, or edit it in place.

To bypass the dialog and set an explicit task slug upfront, use `--slug <name>`:

```text
/workflow interactive-planning --slug oauth2-auth design oauth2 authentication
```

### Prompt-Driven Execution (`workflow_start` Tool)

In addition to user slash-command invocation, agents can start or resume workflows autonomously in response to prompt requests via the `workflow_start` tool:

```json
{
  "workflow": "feature-implementation",
  "task": "prompted-workflow-execution",
  "prompt": "Implement ability to start workflows from prompts"
}
```

The tool resolves the definition, initializes or resumes the run in `.workflow/state.db`, syncs the markdown journal, and returns the orchestration instructions directly in the tool response for immediate execution without turn-injection collisions.

### Inspecting and Resuming Runs

Run `/workflow` with no arguments (or `/workflow list`) to open the interactive selector:

```text
/workflow
```

Displays:

```text
Select a workflow run to inspect or resume:
- [ACTIVE] interactive-planning (oauth2-auth) - state: explore_approaches, rev: 5
- [PAUSED] bug-fix (conn-pool-leak) - state: verify, rev: 3 - waiting for approval
- [COMPLETED] feature-implementation (dark-mode) - state: done, rev: 7
```

Select any active or paused run to resume execution immediately. Selecting a completed or aborted run displays its final state and journal path.

### Responding to Approval Gates

Transitions marked `requires_approval: true` pause automatically and display an interactive dialog:

```text
Workflow 'interactive-planning' (oauth2-auth) requires approval to transition to 'task_breakdown'.
Reason: plan approved; break it into worker-ready tasks

1. Approve transition to 'task_breakdown'
2. Reject transition
3. Chat about it (ask question or discuss)
```

- **Approve**: Commits the transition and advances to the target state.
- **Reject**: Records the rejection in SQLite and leaves the workflow paused in the current state.
- **Chat about it**: Opens an input prompt where you can ask a question or give feedback. The agent answers in chat and immediately re-presents the approval dialog.

---

## Shipped Workflows

The package bundles 8 standard workflows:

| Workflow | Description | Initial State |
|---|---|---|
| `interactive-planning` | Interactive planning with user consent gates, ISC criteria, approach exploration, design validation, and worker-ready task breakdown. | `investigate` |
| `task-implementation` | Implements a single pre-planned task from a plan artifact without re-planning or expanding scope. | `intake` |
| `feature-implementation` | Full feature lifecycle: specification, planning, task implementation loops, verification, and integration. | `intake` |
| `bug-fix` | Reproduces bugs, invokes the debug child workflow, applies minimal fixes, and verifies regression tests. | `reproduce` |
| `debug` | Hypothesis-driven root-cause investigation without speculative edits. | `reproduce` |
| `code-reconnaissance` | Read-only codebase reconnaissance mapping patterns, conventions, and touchpoints. | `map_touchpoints` |
| `refactoring` | Structural code improvements with strict behavioral invariance preservation. | `establish_baseline` |
| `merge-review` | Thorough pre-merge code review checking correctness, security, tests, and conventions. | `diff_analysis` |

---

## Configuration

### Workflow Resolution Precedence

When resolving a workflow by name, the extension searches locations in strict order. The first match wins:

1. `<cwd>/.workflow/workflows/<name>/<name>.yaml` (project-local)
2. `<cwd>/.pi/workflows/<name>/<name>.yaml` (project-local)
3. `~/.pi/agent/workflows/<name>/<name>.yaml` (user-global)
4. Package bundled workflows (fallback)

### Disabling Bundled Workflows

You can disable packaged workflows globally, per-project, or selectively.

#### Global Configuration
Create or edit `~/.pi/agent/extensions/workflow-executor/config.json`:

```json
{
  "disableBundled": true
}
```

Or disable specific workflows globally:

```json
{
  "disabledWorkflows": ["bug-fix", "debug"]
}
```

You can also disable bundled workflows via environment variable:

```bash
export PI_WORKFLOW_DISABLE_BUNDLED=1
```

#### Project-Level Configuration
Create or edit `.workflow/config.json` in your repository:

```json
{
  "disableBundled": true,
  "disabledWorkflows": ["refactoring"]
}
```

---

## Authoring Custom Workflows

Custom workflows are declarative state machines defined in YAML. Place them in:
- Project-local: `.workflow/workflows/<name>/<name>.yaml`
- User-global: `~/.pi/agent/workflows/<name>/<name>.yaml`

### Minimal Example: `deploy-check.yaml`

```yaml
name: deploy-check
version: 1
description: Verify deployment readiness and tag release.

inputs:
  task:
    description: Release or task identifier.
    required: true

initial: check_readiness

states:
  check_readiness:
    goal: Run linters, test suite, and check git status.
    exit_gate: Build passes and git working tree is clean.
    transitions:
      - outcome: tests_failed
        when: Build or tests fail
        to: blocked
        reason: Verification checks failed
      - outcome: ready
        when: exit_gate holds
        to: confirm_deploy
        reason: Readiness verified

  confirm_deploy:
    goal: Request human sign-off before tagging.
    exit_gate: User approves release.
    transitions:
      - outcome: approved
        when: User approves
        to: done
        reason: Sign-off granted
        requires_approval: true

  blocked:
    terminal: true
    goal: Workflow stopped due to verification failures.

  done:
    terminal: true
    goal: Release verified and approved.
```

### Complete Schema Specification

#### Workflow (Root)

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Kebab-case identifier matching the directory name (`[a-z0-9-]+`). |
| `version` | int / string | No | Workflow schema or definition version. |
| `description` | string | No | High-level summary of intent, scope, and invariants. |
| `inputs` | map | No | Input parameter definitions. `task` is always required (`[a-z0-9-]+`). |
| `artifacts` | map | No | Output and intermediate files. Supports `{task}` and `{input}` placeholders. |
| `log` | map | No | Markdown journal declaration (`path`, `description`). |
| `initial` | string | Yes | ID of the initial starting state (must exist in `states`). |
| `states` | map | Yes | Dictionary of state definitions keyed by state ID. |
| `herdr` | map | No | Advisory multiplexer layout hints (`suggested_panes`). |

#### State Definition

| Field | Type | Required | Description |
|---|---|---|---|
| `goal` | string | No | Plain-text goal and scope boundary for the state. |
| `consumes` | string[] | No | Artifacts read during this state. |
| `produces` | string[] | No | Artifacts written during this state. |
| `exit_gate` | string | No | Natural-language condition that must hold before forward transition. |
| `terminal` | boolean | No | If `true`, marks the end of a run (`completed`/`aborted`). No outgoing transitions. |
| `invoke` | object | No | Sub-workflow invocation: `{ workflow: string, inputs?: map, entry?: string }`. |
| `subagent` | string / object | No | Indicates this state should be delegated to a named subagent (e.g. `reviewer`, `worker`, `scout`). |
| `transitions` | object[] | Yes* | List of transition rules (*required for all non-terminal states). |

#### Transition Definition

| Field | Type | Required | Description |
|---|---|---|---|
| `outcome` | string | Yes | Unique token identifying this transition branch (passed to `workflow_transition`). |
| `when` | string | No | Natural-language condition or trigger for this transition. |
| `to` | string | Yes | Target state ID (must exist in `states`). |
| `reason` | string | No | Descriptive reason recorded in SQLite, shown in approval dialogs, and projected to journal. |
| `requires_approval` | boolean | No | If `true`, pauses run and prompts user for interactive confirmation before entering target state. |
| `max_retries` | integer | No | Maximum consecutive loop entries before the thrash guard halts the run (default: 2). |
| `entry` | string | No | Child entry state override when transitioning into an invoked state. |

### Sub-workflows (`invoke:`)

A state can invoke another workflow as a child unit:

```yaml
states:
  run_diagnosis:
    invoke:
      workflow: debug                      # Child workflow name
      inputs: { require_openspec: true }   # Extra child inputs; task is passed through
      entry: diagnose                      # Optional child entry state (default: initial)
    transitions:
      - outcome: debug_completed
        when: "child ended in done"
        to: plan_fix
      - outcome: debug_aborted
        when: "child ended in abort"
        to: abort
```

Child workflows execute with their own run record in SQLite and their own journal. When the child reaches a terminal state, the parent inspects the child's terminal outcome and takes the matching transition.

### Subagent Delegation (`subagent:`)

States declaring `subagent: <name>` (e.g. `reviewer`, `worker`, `scout`) are delegated to that subagent. The orchestrator:
1. Dispatches the subagent with its active state, scoped goal, inputs, and artifact paths.
2. Inspects delivered files and evaluates the state's `exit_gate`.
3. Commits the transition via `workflow_transition`. Subagents never transition or approve gates directly.

---

## Contributing

### Prerequisites

- Node.js >= 22.0.0
- npm

### Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/gierdo/pi-workflow-executor.git
   cd pi-workflow-executor
   ```

2. Run the test suite:
   ```bash
   npm test
   ```

### Testing Guidelines

All tests run using Node's built-in test runner (`node:test` and `node:assert/strict`) with native TypeScript type stripping (`--experimental-strip-types`). No external test frameworks or build steps are required.

- `test/engine.test.ts`: State machine transitions, revision increments, loop limits.
- `test/db.test.ts`: SQLite schema initialization, WAL mode, optimistic locking.
- `test/resolver.test.ts`: Multi-tier resolution hierarchy and config loading.
- `test/slug.test.ts`: Prompt normalization and argument parsing.
- `test/scenarios.test.ts`: End-to-end execution of all 8 standard workflows.

When adding features or bug fixes, add corresponding test coverage under `test/` and verify that `npm test` passes with zero failures.
