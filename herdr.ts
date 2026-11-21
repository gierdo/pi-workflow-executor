import { spawn } from "node:child_process";

export interface HerdrNotification {
  title: string;
  body: string;
}

export const herdrOps = {
  spawn,
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
