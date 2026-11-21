import { Box, Text } from "ink";
import { h } from "../h.ts";
import type { RunRecord } from "../../runner/types.ts";

export interface ConfirmModalProps {
  run: RunRecord;
}

export function ConfirmModal({ run }: ConfirmModalProps) {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: "red",
      paddingX: 2,
      paddingY: 1,
      marginTop: 1,
      marginBottom: 1,
    },
    h(Text, { bold: true, color: "red" }, " CONFIRM DELETION "),
    h(
      Box,
      { marginY: 1 },
      h(
        Text,
        null,
        `Delete run `,
        h(Text, { bold: true }, `'${run.workflow}-${run.task}'`),
        ` and remove its journal folder?`
      )
    ),
    h(
      Text,
      { dimColor: true },
      `Journal path: .workflow/runs/${run.workflow}/${run.task}`
    ),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { bold: true, color: "yellow" }, "Press [y] to confirm, [n] or [Esc] to cancel")
    )
  );
}
