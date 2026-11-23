import process from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useApp, useInput, Box, Text } from "ink";
import { parse as parseYaml } from "yaml";
import { h } from "./h.ts";
import { RunList, type RunListItem } from "./components/RunList.ts";
import { GraphView } from "./components/GraphView.ts";
import { ConfirmModal } from "./components/ConfirmModal.ts";
import { removeWorkflowRun } from "./actions.ts";
import { initDatabase, listRuns, getStateVisits } from "../runner/db.ts";
import { resolveWorkflow, listWorkflows, type WorkflowSource } from "../resolver.ts";
import type { DatabaseSync } from "node:sqlite";
import type { RunRecord, StateVisitRecord, WorkflowDefinition } from "../runner/types.ts";

export interface AppProps {
  projectRoot?: string;
}

export function App({ projectRoot = process.cwd() }: AppProps) {
  const app = useApp();
  const [activeTab, setActiveTab] = useState<"runs" | "definitions">("runs");
  const [selectedRunIndex, setSelectedRunIndex] = useState(0);
  const [selectedDefIndex, setSelectedDefIndex] = useState(0);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [terminalRows, setTerminalRows] = useState(() => process.stdout.rows || 24);

  useEffect(() => {
    const onResize = () => setTerminalRows(process.stdout.rows || 24);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const viewportHeight = Math.max(10, (terminalRows || 24) - 8);

  useEffect(() => {
    setScrollOffset(0);
  }, [selectedRunIndex, selectedDefIndex, activeTab]);

  const [db, setDb] = useState<DatabaseSync | null>(() => {
    const dbPath = join(projectRoot, ".workflow", "state.db");
    if (existsSync(dbPath)) {
      try {
        return initDatabase(dbPath);
      } catch {
        return null;
      }
    }
    return null;
  });

  const [runs, setRuns] = useState<RunRecord[]>(() => {
    const dbPath = join(projectRoot, ".workflow", "state.db");
    if (existsSync(dbPath)) {
      try {
        const currentDb = initDatabase(dbPath);
        return listRuns(currentDb);
      } catch {
        return [];
      }
    }
    return [];
  });

  const [workflows, setWorkflows] = useState<WorkflowSource[]>(() => {
    try {
      return listWorkflows(projectRoot);
    } catch {
      return [];
    }
  });

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Reload data on refreshTrigger
  useEffect(() => {
    if (refreshTrigger === 0) return;
    const dbPath = join(projectRoot, ".workflow", "state.db");
    let currentDb: DatabaseSync | null = null;
    let fetchedRuns: RunRecord[] = [];

    if (existsSync(dbPath)) {
      try {
        currentDb = initDatabase(dbPath);
        fetchedRuns = listRuns(currentDb);
      } catch {
        currentDb = null;
        fetchedRuns = [];
      }
    }

    setDb(currentDb);
    setRuns(fetchedRuns);

    let fetchedWorkflows: WorkflowSource[] = [];
    try {
      fetchedWorkflows = listWorkflows(projectRoot);
    } catch {
      fetchedWorkflows = [];
    }
    setWorkflows(fetchedWorkflows);
  }, [projectRoot, refreshTrigger]);

  // Adjust indices if out of bounds
  useEffect(() => {
    if (runs.length > 0 && selectedRunIndex >= runs.length) {
      setSelectedRunIndex(Math.max(0, runs.length - 1));
    }
  }, [runs, selectedRunIndex]);

  useEffect(() => {
    if (workflows.length > 0 && selectedDefIndex >= workflows.length) {
      setSelectedDefIndex(Math.max(0, workflows.length - 1));
    }
  }, [workflows, selectedDefIndex]);

  const selectedRun = runs[selectedRunIndex] ?? null;
  const selectedTemplate = workflows[selectedDefIndex] ?? null;

  // Resolve definition and visits for selected run or template
  const { definition, visits } = useMemo<{
    definition: WorkflowDefinition | null;
    visits: StateVisitRecord[];
  }>(() => {
    if (activeTab === "runs") {
      if (!selectedRun) return { definition: null, visits: [] };
      const visitRecords = db ? getStateVisits(db, selectedRun.id) : [];
      const resolved = resolveWorkflow(selectedRun.workflow, projectRoot);
      if (!resolved) return { definition: null, visits: visitRecords };
      try {
        const parsed = parseYaml(resolved.rawYaml) as WorkflowDefinition;
        return { definition: parsed, visits: visitRecords };
      } catch {
        return { definition: null, visits: visitRecords };
      }
    } else {
      if (!selectedTemplate) return { definition: null, visits: [] };
      const resolved = resolveWorkflow(selectedTemplate.name, projectRoot);
      if (!resolved) return { definition: null, visits: [] };
      try {
        const parsed = parseYaml(resolved.rawYaml) as WorkflowDefinition;
        return { definition: parsed, visits: [] };
      } catch {
        return { definition: null, visits: [] };
      }
    }
  }, [activeTab, selectedRun, selectedTemplate, db, projectRoot]);

  // Format list items
  const runItems: RunListItem[] = useMemo(() => {
    if (activeTab === "runs") {
      return runs.map((r) => ({
        id: r.id,
        label: `${r.workflow}-${r.task}`,
        badge: `[${r.status.toUpperCase()}]`,
        status: r.status,
      }));
    } else {
      return workflows.map((w) => ({
        id: w.name,
        label: w.name,
        badge: `[${w.source.toUpperCase()}]`,
        source: w.source,
      }));
    }
  }, [activeTab, runs, workflows]);

  const activeIndex = activeTab === "runs" ? selectedRunIndex : selectedDefIndex;

  // Handle keyboard navigation
  useInput((input, key) => {
    if (confirmModalOpen) {
      if (input === "y" || input === "Y") {
        if (selectedRun && db) {
          try {
            removeWorkflowRun(db, selectedRun, projectRoot);
            setStatusMessage(`Deleted run '${selectedRun.workflow}-${selectedRun.task}' and cleaned up journal.`);
            setRefreshTrigger((prev) => prev + 1);
          } catch (err: any) {
            setStatusMessage(`Failed to delete run: ${err?.message || String(err)}`);
          }
        }
        setConfirmModalOpen(false);
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setConfirmModalOpen(false);
        setStatusMessage(null);
        return;
      }
      return;
    }

    if (input === "q" || input === "Q") {
      app.exit();
      return;
    }

    if (key.pageDown || input === "]") {
      setScrollOffset((prev) => prev + 5);
      return;
    }

    if (key.pageUp || input === "[") {
      setScrollOffset((prev) => Math.max(0, prev - 5));
      return;
    }

    if (key.tab) {
      setActiveTab((prev) => (prev === "runs" ? "definitions" : "runs"));
      setStatusMessage(null);
      return;
    }

    if (key.upArrow || input === "k") {
      if (activeTab === "runs") {
        setSelectedRunIndex((prev) => Math.max(0, prev - 1));
      } else {
        setSelectedDefIndex((prev) => Math.max(0, prev - 1));
      }
      return;
    }

    if (key.downArrow || input === "j") {
      if (activeTab === "runs") {
        setSelectedRunIndex((prev) => Math.min(runs.length - 1, prev + 1));
      } else {
        setSelectedDefIndex((prev) => Math.min(workflows.length - 1, prev + 1));
      }
      return;
    }

    if (input === "r" || input === "R") {
      setRefreshTrigger((prev) => prev + 1);
      setStatusMessage("Refreshed runs and workflow definitions.");
      return;
    }

    if (input === "d" || input === "D") {
      if (activeTab === "definitions") {
        setStatusMessage("Cannot delete workflow templates.");
        return;
      }
      if (!selectedRun) {
        setStatusMessage("No run selected to delete.");
        return;
      }
      setConfirmModalOpen(true);
      setStatusMessage(null);
      return;
    }

    if (key.escape) {
      setStatusMessage(null);
    }
  });

  return h(
    Box,
    { flexDirection: "column", width: "100%", paddingX: 1 },
    // Header
    h(
      Box,
      {
        justifyContent: "space-between",
        borderStyle: "bold",
        borderColor: "blue",
        paddingX: 1,
        marginBottom: 1,
      },
      h(Text, { bold: true, color: "blue" }, "PI WORKFLOW DASHBOARD"),
      h(Text, { dimColor: true }, "Press 'q' to quit")
    ),

    // Split Pane
    h(
      Box,
      { flexDirection: "row", width: "100%" },
      h(RunList, {
        items: runItems,
        selectedIndex: activeIndex,
        activeTab,
        width: "40%",
      }),
      h(GraphView, {
        selectedRun,
        selectedTemplate,
        definition,
        visits,
        activeTab,
        width: "60%",
        scrollOffset,
        viewportHeight,
      })
    ),

    // Modal if open
    confirmModalOpen && selectedRun ? h(ConfirmModal, { run: selectedRun }) : null,

    // Status Message if present
    statusMessage
      ? h(
          Box,
          { marginTop: 1, paddingX: 1 },
          h(Text, { bold: true, color: "yellow" }, `► ${statusMessage}`)
        )
      : null,

    // Help Footer
    h(
      Box,
      {
        marginTop: 1,
        paddingX: 1,
        borderStyle: "single",
        borderColor: "gray",
        justifyContent: "space-between",
      },
      h(
        Text,
        { dimColor: true },
        "[↑/↓/k/j] Navigate   [PageUp/PageDown/[] Scroll Graph   [Tab] Switch Tab   [d] Delete Run   [r] Refresh   [q] Quit"
      )
    )
  );
}
