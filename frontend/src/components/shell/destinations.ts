import {
  Bot,
  Box,
  Brain,
  House,
  type LucideIcon,
  MessagesSquare,
  Settings,
} from "lucide-react";

/** One sidebar destination. */
export interface Destination {
  id: "home" | "conversations" | "bots" | "memory" | "sandboxes" | "settings";
  to: string;
  label: string;
  Icon: LucideIcon;
  /** The `g` sequence that goes there, read by the keymap and the shortcut sheet. */
  shortcut?: string;
  /**
   * Whether the page exists yet. A destination whose page has not been built
   * is drawn disabled — never left out — and its shortcut does nothing, so the
   * sidebar's shape does not change as pages arrive.
   */
  available: boolean;
}

/** What a disabled destination says when hovered or announced. */
export const NOT_AVAILABLE = "Not available yet";

/** The product's destinations, top to bottom. Settings sits in the sidebar's foot. */
export const DESTINATIONS: readonly Destination[] = [
  {
    id: "home",
    to: "/home",
    label: "Home",
    Icon: House,
    shortcut: "g h",
    available: false,
  },
  {
    id: "conversations",
    to: "/conversations",
    label: "Conversations",
    Icon: MessagesSquare,
    shortcut: "g c",
    available: true,
  },
  {
    id: "bots",
    to: "/bots",
    label: "Bots",
    Icon: Bot,
    shortcut: "g b",
    available: true,
  },
  {
    id: "memory",
    to: "/memory",
    label: "Memory",
    Icon: Brain,
    shortcut: "g m",
    available: false,
  },
  {
    id: "sandboxes",
    to: "/sandboxes",
    label: "Sandboxes",
    Icon: Box,
    shortcut: "g s",
    available: false,
  },
  {
    id: "settings",
    to: "/settings",
    label: "Settings",
    Icon: Settings,
    available: true,
  },
];
