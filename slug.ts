import { withHerdrBlocked } from "./herdr.ts";

/**
 * Simple, dictionary-free slugifier.
 * Converts raw prompt into a clean kebab-case identifier (max 4 words).
 */
export function slugify(text: string, maxWords = 4): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter(Boolean);

  if (!words.length) return "main";
  return words.slice(0, maxWords).join("-");
}

export interface ParsedWorkflowInvocation {
  name: string;
  task: string;
  prompt: string;
}

export async function parseWorkflowInvocation(
  rawArgs: string,
  ctx: any,
  events?: any
): Promise<ParsedWorkflowInvocation | null> {
  let trimmed = rawArgs.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("/workflow")) {
    trimmed = trimmed.replace(/^\/workflow\s*/, "").trim();
    if (!trimmed) return null;
  }

  // First token is the workflow name
  const firstSpace = trimmed.search(/\s/);
  const name = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace).trim();
  let rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  // Check for optional explicit --slug <name> or --task <name>
  let explicitSlug: string | null = null;
  const slugMatch = rest.match(/(?:--slug|--task)\s+["']?([a-z0-9-]+)["']?/i);
  if (slugMatch) {
    explicitSlug = slugMatch[1].toLowerCase();
    rest = rest.replace(slugMatch[0], "").replace(/\s+/g, " ").trim();
  }

  // Strip optional surrounding quotes if the entire prompt was quoted
  const prompt = rest.replace(/^["']|["']$/g, "").trim();

  let task = explicitSlug || (prompt ? slugify(prompt) : "main");

  // In interactive UI, let user confirm or customize pre-filled slug if auto-derived
  if (!explicitSlug && ctx?.ui?.input) {
    try {
      const promptText = "Workflow task slug (press Enter to accept):";
      const promptArg = Object.assign(new String(promptText), {
        prompt: promptText,
        value: task,
      });
      const confirmed = await withHerdrBlocked(
        events,
        "Confirm workflow task slug",
        {
          title: "Confirm workflow task slug",
          body: `Confirm or customize task slug for workflow '${name}'`,
        },
        () => ctx.ui.input(promptArg, task)
      );
      const val = typeof confirmed === "string" ? confirmed : confirmed?.value;
      if (val && typeof val === "string" && val.trim()) {
        task = val.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      }
    } catch {
      // User cancelled; retain derived task
    }
  }

  return { name, task: task || "main", prompt };
}
