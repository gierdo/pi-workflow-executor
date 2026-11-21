import React from "react";

export function h<P extends object>(
  type: React.ComponentType<P> | string,
  props?: (P & React.Attributes) | null,
  ...children: React.ReactNode[]
): React.ReactElement {
  return React.createElement(type, props, ...children);
}
