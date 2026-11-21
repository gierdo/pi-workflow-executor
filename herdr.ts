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
 * Creates a Git worktree via Herdr CLI.
 * Only allowed when running inside Herdr (HERDR_ENV=1).
 */
export function createHerdrWorktree(params: {
  cwd: string;
  branch: string;
  label: string;
}): { worktreePath: string; workspaceId?: string } {
  if (!isHerdrActive()) {
    throw new Error("Cannot create Herdr worktree outside a Herdr environment (HERDR_ENV!=1)");
  }
  const output = herdrOps.execSync(
    `herdr worktree create --cwd "${params.cwd}" --branch "${params.branch}" --label "${params.label}" --no-focus`,
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(output.toString());
  return {
    worktreePath: parsed.result?.worktree?.path ?? parsed.worktree?.path ?? "",
    workspaceId: parsed.result?.workspace?.id ?? parsed.workspace?.id,
  };
}

/**
 * Removes a Herdr worktree workspace by ID.
 * Silently ignores removal if outside Herdr.
 */
export function removeHerdrWorktree(workspaceId: string): void {
  if (!isHerdrActive()) return;
  herdrOps.execSync(`herdr worktree remove --workspace "${workspaceId}" --force`, { stdio: "ignore" });
}

