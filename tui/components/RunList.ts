import { Box, Text } from "ink";
import { h } from "../h.ts";

export interface RunListItem {
  id: string;
  label: string;
  badge: string;
  status?: string;
  source?: string;
}

export interface RunListProps {
  items: RunListItem[];
  selectedIndex: number;
  activeTab: "runs" | "definitions";
  width?: string | number;
}

function getBadgeColor(status?: string, source?: string): string {
  if (status === "active") return "yellow";
  if (status === "paused") return "cyan";
  if (status === "completed") return "green";
  if (status === "aborted") return "red";

  if (source === "project") return "green";
  if (source === "global") return "magenta";
  if (source === "bundled") return "blue";

  return "dim";
}

export function RunList({ items, selectedIndex, activeTab, width = "40%" }: RunListProps) {
  const title = activeTab === "runs" ? " WORKFLOW RUNS " : " WORKFLOW TEMPLATES ";

  return h(
    Box,
    {
      flexDirection: "column",
      width,
      borderStyle: "single",
      borderColor: "gray",
      paddingX: 1,
    },
    h(
      Box,
      { justifyContent: "space-between", marginBottom: 1 },
      h(Text, { bold: true, color: "cyan" }, title),
      h(Text, { dimColor: true }, "[Tab]")
    ),
    items.length === 0
      ? h(
          Box,
          { marginY: 1, flexDirection: "column" },
          h(
            Text,
            { dimColor: true },
            activeTab === "runs"
              ? "No workflow runs found.\nPress Tab to view defined workflows."
              : "No workflow templates found."
          )
        )
      : items.map((item, idx) => {
          const isSelected = idx === selectedIndex;
          const prefix = isSelected ? "> " : "  ";
          const badgeColor = getBadgeColor(item.status, item.source);

          return h(
            Box,
            { key: item.id },
            h(Text, { color: isSelected ? "cyan" : "dim", bold: isSelected }, prefix),
            h(
              Text,
              {
                wrap: "truncate-end",
                bold: isSelected,
              },
              h(Text, { color: badgeColor, bold: isSelected }, item.badge),
              " ",
              h(
                Text,
                {
                  underline: isSelected,
                  color: isSelected ? "white" : undefined,
                },
                item.label
              )
            )
          );
        })
  );
}
