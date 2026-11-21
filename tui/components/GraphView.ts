import { Box, Text } from "ink";
import { h } from "../h.ts";
import { buildGraphModel } from "../graph.ts";
import type { WorkflowDefinition, RunRecord, StateVisitRecord } from "../../runner/types.ts";
import type { WorkflowSource } from "../../resolver.ts";

export interface GraphViewProps {
  selectedRun?: RunRecord | null;
  selectedTemplate?: WorkflowSource | null;
  definition?: WorkflowDefinition | null;
  visits?: StateVisitRecord[];
  activeTab: "runs" | "definitions";
  width?: string | number;
  scrollOffset?: number;
  viewportHeight?: number;
}

export function GraphView({
  selectedRun,
  selectedTemplate,
  definition,
  visits = [],
  activeTab,
  width = "60%",
  scrollOffset = 0,
  viewportHeight = 16,
}: GraphViewProps) {
  const isRuns = activeTab === "runs";

  if (isRuns && !selectedRun) {
    return h(
      Box,
      {
        flexDirection: "column",
        width,
        height: viewportHeight,
        overflow: "hidden",
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
      },
      h(Text, { bold: true, color: "blue" }, " STATE MACHINE GRAPH "),
      h(Box, { marginY: 1 }, h(Text, { dimColor: true }, "No workflow run selected."))
    );
  }

  if (!isRuns && !selectedTemplate) {
    return h(
      Box,
      {
        flexDirection: "column",
        width,
        height: viewportHeight,
        overflow: "hidden",
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
      },
      h(Text, { bold: true, color: "blue" }, " STATE MACHINE GRAPH "),
      h(Box, { marginY: 1 }, h(Text, { dimColor: true }, "No workflow template selected."))
    );
  }

  let titleLine = "";
  let metaLine = "";
  let lines: string[] = [];

  if (isRuns && selectedRun) {
    titleLine = `Workflow: ${selectedRun.workflow} [${selectedRun.task}]`;
    metaLine = `Status: [${selectedRun.status.toUpperCase()}] | State: ${selectedRun.current_state} | Rev: ${selectedRun.revision} | Updated: ${selectedRun.updated_at}`;

    if (definition) {
      const visitedIds = visits.map((v) => v.state_id);
      lines = buildGraphModel(definition, visitedIds, selectedRun.current_state);
    } else {
      lines = ["Workflow definition not found. Visited history:"];
      if (visits.length === 0) {
        lines.push("  (no recorded state visits)");
      } else {
        for (const v of visits) {
          const exited = v.exited_at ? ` -> exited ${v.exited_at}` : " (current)";
          lines.push(`  • #${v.visit_index} ${v.state_id} (entered ${v.entered_at}${exited})`);
        }
      }
    }
  } else if (!isRuns && selectedTemplate) {
    titleLine = `Template: ${selectedTemplate.name}`;
    metaLine = `Source: [${selectedTemplate.source.toUpperCase()}] | Path: ${selectedTemplate.path}`;

    if (definition) {
      lines = buildGraphModel(definition, [], definition.initial);
    } else {
      lines = ["Unable to load workflow YAML definition."];
    }
  }

  const totalLines = lines.length;
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, totalLines - viewportHeight)));
  const visibleLines = lines.slice(clampedOffset, clampedOffset + viewportHeight);
  const hasMore = totalLines > viewportHeight;

  const scrollBadge = hasMore
    ? `[Viewing lines ${clampedOffset + 1}-${Math.min(totalLines, clampedOffset + viewportHeight)} of ${totalLines} | PageUp/PageDown or [] to scroll]`
    : "";

  return h(
    Box,
    {
      flexDirection: "column",
      width,
      height: viewportHeight,
      overflow: "hidden",
      borderStyle: "single",
      borderColor: "gray",
      paddingX: 1,
    },
    h(
      Box,
      { flexDirection: "column", marginBottom: 1, flexShrink: 0 },
      h(Text, { bold: true, color: "blue" }, titleLine),
      h(Text, { dimColor: true }, metaLine),
      scrollBadge ? h(Text, { color: "yellow" }, scrollBadge) : null
    ),
    h(
      Box,
      { flexDirection: "column", flexShrink: 0 },
      visibleLines.map((line, idx) => h(Text, { key: idx }, line))
    )
  );
}
