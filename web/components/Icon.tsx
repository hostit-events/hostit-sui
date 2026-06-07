import React from "react";

/**
 * Thin wrapper over the Iconify web component (the HostIt design references
 * Iconify icon names directly). The loader script is added once in layout.tsx.
 * Rendered via createElement so we don't need a JSX type for the custom element.
 */
export function Icon({
  icon,
  size = 18,
  className,
  style,
}: {
  icon: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return React.createElement("iconify-icon", {
    icon,
    width: size,
    height: size,
    className,
    style: { display: "inline-flex", lineHeight: 0, verticalAlign: "-0.125em", ...style },
  });
}
