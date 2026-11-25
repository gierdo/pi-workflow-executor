import { spawn, execSync } from "node:child_process";

export interface HerdrNotification {
  title: string;
  body: string;
}

export const herdrOps = {
  spawn,
  execSync,
};

/**
 * Checks whether the current process is running inside Herdr.
 */
export function isHerdrActive(): boolean {
  return process.env.HERDR_ENV === "1";
}

/**
 * Fires a desktop notification via Herdr CLI in a detached, non-blocking process.
 * Best-effort and fully isolated: failures, missing binary, or errors are silently ignored.
 */
export function notifyHerdr(title: string, body: string): void {
  try {
    const child = herdrOps.spawn(
      "herdr",
      ["notification", "show", title, "--body", body, "--sound", "request"],
      { stdio: "ignore", detached: true }
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore error: notification is best-effort and non-blocking
  }
}

/**
 * Wraps an interactive prompt with Herdr's `herdr:blocked` event lifecycle.
 * Emits `{ active: true, label }` before `fn()` and guarantees `{ active: false }`
 * in `finally`.
 */
export async function withHerdrBlocked<T>(
  events: any,
  label: string,
  notification: HerdrNotification | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!isHerdrActive() || typeof events?.emit !== "function") {
    return await fn();
  }

  if (notification) {
    notifyHerdr(notification.title, notification.body);
  }

  events.emit("herdr:blocked", { active: true, label });
  try {
    return await fn();
  } finally {
    events.emit("herdr:blocked", { active: false });
  }
}

/**
 * Returns the Worktrunk binary name or path, honoring `WORKTRUNK_BIN`.
 */
export function getWorktrunkBin(): string {
  return process.env.WORKTRUNK_BIN || "wt";
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatDoubleQuotedArg(value: string): string {
  return `"${escapeDoubleQuoted(value)}"`;
}

function formatWorktrunkBin(bin: string = getWorktrunkBin()): string {
  return /^[A-Za-z0-9_./:-]+$/.test(bin) ? bin : formatDoubleQuotedArg(bin);
}

/**
 * Checks whether the Worktrunk (`wt`) CLI is available in the current environment.
 */
export function isWorktrunkAvailable(): boolean {
  try {
    herdrOps.execSync(`${formatWorktrunkBin()} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function extractWorktrunkPathFromList(rawJson: string, branch: string): string {
  const parsed = JSON.parse(rawJson);
  const items: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : [];
  for (const item of items) {
    if (!item || item.branch !== branch) continue;
    const isWorktree =
      item.kind === "worktree" ||
      (item.worktree !== null && typeof item.worktree === "object");
    if (!isWorktree) continue;
    const candidate = item.worktree?.path ?? item.path;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "";
}

/**
 * Creates a Git worktree via Worktrunk (`wt`) and registers it as a Herdr workspace.
 * Only allowed when running inside Herdr (HERDR_ENV=1).
 */
export function createHerdrWorktree(params: {
  cwd: string;
  branch: string;
  label: string;
  baseBranch?: string;
}): { worktreePath: string; workspaceId?: string; branch: string } {
  if (!isHerdrActive()) {
    throw new Error("Cannot create Herdr worktree outside a Herdr environment (HERDR_ENV!=1)");
  }
  const wtBinCmd = formatWorktrunkBin();
  const baseArg = params.baseBranch ? ` --base ${formatDoubleQuotedArg(params.baseBranch)}` : "";
  const wtOut = herdrOps.execSync(
    `${wtBinCmd} switch --create ${formatDoubleQuotedArg(params.branch)}${baseArg} --no-cd --format=json -y`,
    { cwd: params.cwd, encoding: "utf8" }
  );
  const wtParsed = JSON.parse(wtOut.toString());
  const resolvedBranch: string = wtParsed.branch ?? params.branch;
  let worktreePath: string = wtParsed.path ?? wtParsed.result?.path ?? "";

  if (!worktreePath) {
    const listOut = herdrOps.execSync(`${wtBinCmd} list --format=json`, {
      cwd: params.cwd,
      encoding: "utf8",
    });
    worktreePath = extractWorktrunkPathFromList(listOut.toString(), resolvedBranch);
  }

  if (!worktreePath) {
    throw new Error(`Worktrunk returned no worktree path for branch "${resolvedBranch}"`);
  }

  const herdrOut = herdrOps.execSync(
    `herdr worktree open --cwd ${formatDoubleQuotedArg(params.cwd)} --path ${formatDoubleQuotedArg(worktreePath)} --label ${formatDoubleQuotedArg(params.label)} --no-focus --json`,
    { cwd: params.cwd, encoding: "utf8" }
  );
  const herdrParsed = JSON.parse(herdrOut.toString());
  const workspaceId: string | undefined =
    herdrParsed.result?.workspace?.workspace_id ??
    herdrParsed.result?.workspace?.id ??
    herdrParsed.workspace?.workspace_id ??
    herdrParsed.workspace?.id;

  return { worktreePath, workspaceId, branch: resolvedBranch };
}

export interface RemoveHerdrWorktreeParams {
  cwd?: string;
  branch?: string;
  workspaceId?: string;
  force?: boolean;
}

/**
 * Removes a Worktrunk worktree (when `branch` is provided) and closes its Herdr workspace
 * (when `workspaceId` is provided). Accepts a workspaceId string for backward compatibility.
 * Silently ignores removal if outside Herdr.
 */
export function removeHerdrWorktree(target: string | RemoveHerdrWorktreeParams): void {
  if (!isHerdrActive()) return;
  const params: RemoveHerdrWorktreeParams =
    typeof target === "string" ? { workspaceId: target } : target;

  if (params.branch) {
    const wtBinCmd = formatWorktrunkBin();
    const cwdArg = params.cwd ? ` -C ${formatDoubleQuotedArg(params.cwd)}` : "";
    const forceArg = params.force ? " --force -D" : "";
    herdrOps.execSync(
      `${wtBinCmd} remove --foreground${cwdArg} ${formatDoubleQuotedArg(params.branch)}${forceArg} -y`,
      { ...(params.cwd ? { cwd: params.cwd } : {}), stdio: "ignore" }
    );
  }

  if (params.workspaceId) {
    herdrOps.execSync(`herdr workspace close ${formatDoubleQuotedArg(params.workspaceId)}`, {
      stdio: "ignore",
    });
  }
}

export interface MergeHerdrWorktreeParams {
  cwd: string;
  worktreePath: string;
  branch: string;
  targetBranch?: string;
  workspaceId?: string;
  flags?: string[];
}

/**
 * Merges a Worktrunk worktree into its target branch (`--no-remove`), then synchronously
 * removes the worktree and closes its Herdr workspace.
 */
export function mergeHerdrWorktree(params: MergeHerdrWorktreeParams): void {
  if (!isHerdrActive()) {
    throw new Error("Cannot merge Herdr worktree outside a Herdr environment (HERDR_ENV!=1)");
  }
  const wtBinCmd = formatWorktrunkBin();
  const targetArg = params.targetBranch ? ` ${formatDoubleQuotedArg(params.targetBranch)}` : "";
  const extraFlags = params.flags?.length ? ` ${params.flags.join(" ")}` : "";
  herdrOps.execSync(
    `${wtBinCmd} merge${targetArg} -C ${formatDoubleQuotedArg(params.worktreePath)} --no-remove${extraFlags} -y`,
    { cwd: params.worktreePath, encoding: "utf8" }
  );
  removeHerdrWorktree({
    cwd: params.cwd,
    branch: params.branch,
    workspaceId: params.workspaceId,
  });
}

