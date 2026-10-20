import {
  BookOpen,
  Cpu,
  House,
  type LucideIcon,
  MessagesSquare,
  PanelLeft,
  Route,
  Settings,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { Mark } from "../../ui";
import NotificationBell from "../NotificationBell";
import { AccountMenu } from "./AccountMenu";
import { ProjectSwitcher } from "./ProjectSwitcher";

/** One sidebar destination. */
interface NavItem {
  id: string;
  to: string;
  label: string;
  Icon: LucideIcon;
}

/** The product's destinations, top to bottom. Counts arrive with the live channels. */
export const NAV_ITEMS: NavItem[] = [
  { id: "home", to: "/home", label: "Home", Icon: House },
  { id: "sessions", to: "/sessions", label: "Sessions", Icon: MessagesSquare },
  { id: "runners", to: "/runners", label: "Runners", Icon: Cpu },
  { id: "routing", to: "/routing", label: "Routing", Icon: Route },
];

/** See {@link Sidebar}. */
export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Live counts by nav id; a missing or zero count is not drawn. */
  counts?: Partial<Record<string, number>>;
  /** Called after a destination is chosen — the mobile sheet closes on it. */
  onNavigate?: () => void;
}

/**
 * The sidebar: mark, project switcher, destinations with counts, the
 * notification bell, docs, and the account menu. Collapsed, it draws icons only and keeps every control mounted.
 * @param props - See {@link SidebarProps}.
 * @returns The sidebar.
 */
export function Sidebar({
  collapsed,
  onToggle,
  counts = {},
  onNavigate,
}: SidebarProps) {
  const link = (item: NavItem) => {
    const count = counts[item.id];
    return (
      <NavLink
        key={item.id}
        to={item.to}
        data-testid={`nav-${item.id}`}
        className={({ isActive }) =>
          `shell-nav-item${isActive ? " is-active" : ""}`
        }
        title={collapsed ? item.label : undefined}
        onClick={onNavigate}
      >
        <item.Icon size={16} aria-hidden="true" />
        <span className="shell-nav-label">{item.label}</span>
        {!!count && <span className="shell-nav-count tabular">{count}</span>}
      </NavLink>
    );
  };

  return (
    <nav
      className="shell-sidebar"
      data-testid="sidebar"
      data-collapsed={collapsed}
      aria-label="Main"
    >
      <div className="shell-brand">
        <Mark size={16} label={null} className="shell-brand-mark" />
        <span className="shell-brand-name">Hypotenuse</span>
        <button
          type="button"
          className="shell-icon-button shell-sidebar-toggle"
          data-testid="sidebar-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          onClick={onToggle}
        >
          <PanelLeft size={16} aria-hidden="true" />
        </button>
      </div>
      <ProjectSwitcher onNavigate={onNavigate} />
      <div className="shell-nav">{NAV_ITEMS.map(link)}</div>
      <div className="shell-nav shell-nav-foot">
        <NotificationBell collapsed={collapsed} />
        {link({
          id: "settings",
          to: "/settings",
          label: "Settings",
          Icon: Settings,
        })}
        <NavLink
          to="/docs"
          data-testid="nav-docs"
          className="shell-nav-item"
          title={collapsed ? "Docs" : undefined}
          onClick={onNavigate}
        >
          <BookOpen size={16} aria-hidden="true" />
          <span className="shell-nav-label">Docs</span>
        </NavLink>
      </div>
      <AccountMenu collapsed={collapsed} />
    </nav>
  );
}
