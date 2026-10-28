import { BookOpen, PanelLeft, X } from "lucide-react";
import { NavLink } from "react-router-dom";
import { Mark } from "../../ui";
import { AccountMenu } from "./AccountMenu";
import { DESTINATIONS, type Destination, NOT_AVAILABLE } from "./destinations";
import { NotificationBell } from "./NotificationBell";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { ProjectSwitcher } from "./ProjectSwitcher";
import type { ShellActions, ShellData } from "./shellData";

/** See {@link Sidebar}. */
export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** The organizations, projects, and person the switchers and account menu show. */
  data: ShellData;
  /** What the switchers and account menu do, and what they may not. */
  actions: ShellActions;
  /** Live counts by destination id; a missing or zero count is not drawn. */
  counts?: Partial<Record<Destination["id"], number>>;
  /** Called after a destination is chosen — the mobile sheet closes on it. */
  onNavigate?: () => void;
  /** Drawn inside the mobile sheet: the toggle closes the sheet rather than collapsing. */
  inSheet?: boolean;
}

/**
 * The sidebar: mark, the organization then project switchers, the
 * destinations with counts, the notification bell, docs, and the account menu. A destination whose
 * page does not exist yet is drawn disabled, never left out. Collapsed, it
 * draws icons only and keeps every control mounted.
 * @param props - See {@link SidebarProps}.
 * @returns The sidebar.
 */
export function Sidebar({
  collapsed,
  onToggle,
  data,
  actions,
  counts = {},
  onNavigate,
  inSheet = false,
}: SidebarProps) {
  const link = (item: Destination) => {
    const count = counts[item.id];
    const body = (
      <>
        <item.Icon size={16} aria-hidden="true" />
        <span className="shell-nav-label">{item.label}</span>
        {!!count && <span className="shell-nav-count tabular">{count}</span>}
      </>
    );
    if (!item.available) {
      return (
        <span
          key={item.id}
          className="shell-nav-item is-disabled"
          data-testid={`nav-${item.id}`}
          aria-disabled="true"
          title={collapsed ? `${item.label} · ${NOT_AVAILABLE}` : NOT_AVAILABLE}
        >
          {body}
          <span className="visually-hidden"> ({NOT_AVAILABLE})</span>
        </span>
      );
    }
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
        {body}
      </NavLink>
    );
  };

  const main = DESTINATIONS.filter((d) => d.id !== "settings");
  const settings = DESTINATIONS.find((d) => d.id === "settings");

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
          aria-label={
            inSheet
              ? "Close navigation"
              : collapsed
                ? "Expand sidebar"
                : "Collapse sidebar"
          }
          aria-pressed={inSheet ? undefined : collapsed}
          onClick={onToggle}
        >
          {inSheet ? (
            <X size={16} aria-hidden="true" />
          ) : (
            <PanelLeft size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <OrganizationSwitcher
        organizations={data.organizations}
        activeOrganizationId={data.activeOrganizationId}
        onSelect={actions.selectOrganization}
        newProjectDenied={actions.newProjectDenied}
        newOrganizationDenied={actions.newOrganizationDenied}
        onNavigate={onNavigate}
      />
      <ProjectSwitcher
        projects={data.projects}
        activeProjectId={data.activeProjectId}
        onSelect={actions.selectProject}
        onNavigate={onNavigate}
      />
      <div className="shell-nav">{main.map(link)}</div>
      <div className="shell-nav shell-nav-foot">
        <NotificationBell collapsed={collapsed} signedIn={data.user !== null} />
        {settings && link(settings)}
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
      <AccountMenu
        collapsed={collapsed}
        user={data.user}
        onSignOut={actions.signOut}
        pendingInvites={actions.pendingInvites}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
