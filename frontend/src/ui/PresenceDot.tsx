import type { ComponentType } from "react";
import {
  DrainingGlyph,
  type GlyphProps,
  OfflineGlyph,
  OnlineGlyph,
} from "./glyphs";

/** A runner's presence. */
export type RunnerPresence = "online" | "offline" | "draining";

const PRESENCE: Record<
  RunnerPresence,
  { Shape: ComponentType<GlyphProps>; label: string }
> = {
  online: { Shape: OnlineGlyph, label: "Online" },
  offline: { Shape: OfflineGlyph, label: "Offline" },
  draining: { Shape: DrainingGlyph, label: "Draining" },
};

/**
 * A runner's presence: a solid dot (online), a hollow dot (offline), or a half
 * dot (draining). Shape carries the state; the token colour reinforces it.
 * @param props - `presence`, plus any glyph prop.
 * @returns The presence dot.
 */
export function PresenceDot({
  presence,
  ...props
}: GlyphProps & { presence: RunnerPresence }) {
  const { Shape, label } = PRESENCE[presence];
  return <Shape label={label} {...props} />;
}
