import type { ReactNode, SVGProps } from "react";

/** Props every glyph accepts. */
export type GlyphProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  /**
   * What a screen reader hears. Every glyph has one by default, because the
   * shape is the information: a glyph that is only decoration should pass
   * `label={null}`, which hides it from assistive technology instead.
   */
  label?: string | null;
  /** Rendered size in px. 14 is the list and transcript size. */
  size?: number;
};

/** The disc every filled glyph knocks its mark out of, as one subpath. */
export const DISC = "M1 7 A6 6 0 1 0 13 7 A6 6 0 1 0 1 7 Z";

/**
 * The shared SVG frame: a 14-unit box drawn in `currentColor`, so the colour
 * comes from the `ui-glyph-*` class (a token) and never from the markup.
 * @param props - Glyph props plus the `kind` class suffix and the shape.
 * @returns The SVG.
 */
export function Glyph({
  kind,
  label,
  size = 14,
  className,
  children,
  ...props
}: GlyphProps & { kind: string; children: ReactNode }) {
  const named = label !== null && label !== undefined;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="none"
      className={["ui-glyph", `ui-glyph-${kind}`, className]
        .filter(Boolean)
        .join(" ")}
      data-glyph={kind}
      role={named ? "img" : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
      focusable="false"
    >
      {children}
    </svg>
  );
}
