import type { WorkflowDefinition } from "../runner/types.ts";

export interface GraphNode {
  id: string;
  label: string;
  level: number;
  visited: boolean;
  active: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  outcome?: string;
}

export function computeGraphNodes(
  def: WorkflowDefinition,
  visitedStateIds: string[] = [],
  currentState?: string
): GraphNode[] {
  const states = def.states || {};
  const stateKeys = Object.keys(states);
  const initial = def.initial || stateKeys[0] || "";

  const visitedBfs = new Set<string>();
  const levelMap = new Map<string, number>();

  if (initial) {
    const queue: string[] = [initial];
    visitedBfs.add(initial);
    levelMap.set(initial, 0);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentLevel = levelMap.get(current) ?? 0;
      const stateDef = states[current];
      const transitions = stateDef?.transitions || [];

      for (const t of transitions) {
        if (t.to && !visitedBfs.has(t.to)) {
          visitedBfs.add(t.to);
          levelMap.set(t.to, currentLevel + 1);
          queue.push(t.to);
        }
      }
    }
  }

  // Find max assigned level so unreachable states appear at the end
  let maxLevel = 0;
  for (const lvl of levelMap.values()) {
    if (lvl > maxLevel) maxLevel = lvl;
  }

  for (const key of stateKeys) {
    if (!levelMap.has(key)) {
      maxLevel += 1;
      levelMap.set(key, maxLevel);
    }
  }

  const nodes: GraphNode[] = stateKeys.map((stateId) => {
    return {
      id: stateId,
      label: stateId,
      level: levelMap.get(stateId) ?? 0,
      visited: visitedStateIds.includes(stateId),
      active: currentState === stateId,
    };
  });

  // Sort primarily by level, then alphabetically by state id
  nodes.sort((a, b) => {
    if (a.level !== b.level) {
      return a.level - b.level;
    }
    return a.id.localeCompare(b.id);
  });

  return nodes;
}

export function computeGraphEdges(def: WorkflowDefinition): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const states = def.states || {};

  for (const [stateId, stateDef] of Object.entries(states)) {
    if (!stateDef.transitions) continue;
    for (const t of stateDef.transitions) {
      if (t.to) {
        edges.push({
          from: stateId,
          to: t.to,
          outcome: t.outcome,
        });
      }
    }
  }

  return edges;
}

export function buildGraphModel(
  def: WorkflowDefinition,
  visitedStateIds: string[] = [],
  currentState?: string
): string[] {
  const nodes = computeGraphNodes(def, visitedStateIds, currentState);
  const edges = computeGraphEdges(def);

  if (nodes.length === 0) {
    return ["(empty workflow definition)"];
  }

  const lines: string[] = [];
  const boxWidth = 32;
  const half = Math.floor(boxWidth / 2);
  const topBorder = `╭${"─".repeat(half - 1)}┴${"─".repeat(boxWidth - half - 2)}╮`;
  const bottomBorder = `╰${"─".repeat(half - 1)}┬${"─".repeat(boxWidth - half - 2)}╯`;
  const centerPad = " ".repeat(half);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const nextNode = nodes[i + 1];
    const stateDef = def.states?.[node.id];
    const isTerminal = Boolean(stateDef?.terminal);

    // Format badge and label
    let marker = "  ";
    let tag = "";
    if (node.active) {
      marker = "► ";
      tag = " [CURRENT]";
    } else if (node.visited) {
      marker = "✓ ";
    }

    if (isTerminal && !node.active) {
      tag = " [TERMINAL]";
    }

    const titleText = `${marker}${node.id}${tag}`;
    const truncatedTitle = titleText.length > boxWidth - 4
      ? titleText.slice(0, boxWidth - 7) + "..."
      : titleText;
    const paddedTitle = truncatedTitle.padEnd(boxWidth - 4, " ");

    const middleLine = `│ ${paddedTitle} │`;

    lines.push(topBorder);
    lines.push(middleLine);

    // If there is a short goal or description, render a second line inside box
    if (stateDef?.goal) {
      const cleanGoal = stateDef.goal.replace(/\s+/g, " ").trim();
      const truncatedGoal = cleanGoal.length > boxWidth - 4
        ? cleanGoal.slice(0, boxWidth - 7) + "..."
        : cleanGoal;
      const paddedGoal = truncatedGoal.padEnd(boxWidth - 4, " ");
      lines.push(`│ ${paddedGoal} │`);
    }

    lines.push(bottomBorder);

    // Outgoing edges
    const outgoing = edges.filter((e) => e.from === node.id);

    let sequentialEdge: GraphEdge | undefined;
    const loopEdges: GraphEdge[] = [];

    if (nextNode) {
      const seqIdx = outgoing.findIndex((e) => e.to === nextNode.id);
      if (seqIdx !== -1) {
        sequentialEdge = outgoing[seqIdx];
        for (let j = 0; j < outgoing.length; j++) {
          if (j !== seqIdx) {
            loopEdges.push(outgoing[j]!);
          }
        }
      } else {
        loopEdges.push(...outgoing);
      }
    } else {
      loopEdges.push(...outgoing);
    }

    if (outgoing.length === 0) {
      if (isTerminal) {
        lines.push("  (terminal state)");
      }
    } else {
      for (const jump of loopEdges) {
        const outcomeLabel = jump.outcome ? ` [${jump.outcome}]` : "";
        lines.push(`${centerPad}│   ╭──${outcomeLabel}`);
        lines.push(`${centerPad}│   │`);
        lines.push(`${centerPad}│   ╰──► ${jump.to}`);
      }

      if (sequentialEdge) {
        lines.push(`${centerPad}│`);
        if (sequentialEdge.outcome) {
          lines.push(`${centerPad}│ [${sequentialEdge.outcome}]`);
        }
        lines.push(`${centerPad}▼`);
      }
    }

    if (i < nodes.length - 1 && !sequentialEdge) {
      lines.push("");
    }
  }

  return lines;
}
