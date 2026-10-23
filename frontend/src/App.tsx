import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import NotificationToasts from "./components/NotificationToasts";
import ProtectedRoute from "./components/ProtectedRoute";
import { DEFAULT_SETTINGS_SECTION } from "./components/settings/sections";
import DangerZoneSection from "./components/settings/sections/DangerZoneSection";
import GeneralSection from "./components/settings/sections/GeneralSection";
import IntegrationsSection from "./components/settings/sections/IntegrationsSection";
import McpSection from "./components/settings/sections/McpSection";
import MembersSection from "./components/settings/sections/MembersSection";
import RoutingSection from "./components/settings/sections/RoutingSection";
import TagsSection from "./components/settings/sections/TagsSection";
import TelemetrySection from "./components/settings/sections/TelemetrySection";
import { PublicShell } from "./components/shell/PublicShell";
import { AuthProvider } from "./context/AuthContext";
import { LiveSocketProvider } from "./context/LiveSocketContext";
import { NotificationProvider } from "./context/NotificationContext";
import AccountPage from "./pages/AccountPage";
import AuditLogPage from "./pages/AuditLogPage";
import { CliActivatePage } from "./pages/cli/CliActivatePage";
import { CliAuthorizePage } from "./pages/cli/CliAuthorizePage";
import { DocsLayout } from "./pages/docs/DocsLayout";
import { DocsPage } from "./pages/docs/DocsPage";
import EventPage from "./pages/EventPage";
import EventsPage from "./pages/EventsPage";
import IdentitiesPage from "./pages/IdentitiesPage";
import InvitesPage from "./pages/InvitesPage";
import { HomePage } from "./pages/marketing/HomePage";
import NewProjectPage from "./pages/NewProjectPage";
import ProjectHomePage from "./pages/ProjectHomePage";
import RoutingPage from "./pages/RoutingPage";
import RunnerAuthPage from "./pages/RunnerAuthPage";
import RunnersPage from "./pages/RunnersPage";
import SessionPage from "./pages/SessionPage";
import SessionsPage from "./pages/SessionsPage";
import SettingsPage from "./pages/SettingsPage";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { StatusPage } from "./pages/StatusPage";
import { StyleGuidePage } from "./pages/StyleGuidePage";
import { Alert } from "./ui";

/**
 * The route table. Public pages sit in `PublicShell`; the product sits in
 * `AppShell`, behind {@link ProtectedRoute} — the single place that decides
 * where a signed-out or project-less visitor goes.
 *
 * The whole tree sits inside `AuthProvider`, because the shell needs the
 * session on every page, and inside the live socket and notification
 * providers, because a toast can arrive on any of them.
 * @returns The routed application.
 */
export function App() {
  return (
    <AuthProvider>
      <LiveSocketProvider>
        <NotificationProvider>
          <NotificationToasts />
          <Routes>
            <Route element={<PublicShell />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/docs" element={<DocsLayout />}>
                <Route index element={<DocsPage />} />
                <Route path=":slug" element={<DocsPage />} />
              </Route>
              <Route path="/sign-in" element={<SignInPage />} />
              <Route path="/sign-up" element={<SignUpPage />} />
            </Route>
            <Route element={<AppShell />}>
              <Route path="/status" element={<StatusPage />} />
            </Route>
            <Route element={<ProtectedRoute />}>
              {/* Approving a CLI is a focused, one-decision page: the public
                  frame, not the app shell, but behind sign-in. */}
              <Route element={<PublicShell />}>
                <Route path="/cli/authorize" element={<CliAuthorizePage />} />
                <Route path="/cli/activate" element={<CliActivatePage />} />
              </Route>
              <Route element={<AppShell />}>
                <Route path="/home" element={<ProjectHomePage />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/sessions/:id" element={<SessionPage />} />
                <Route path="/runners" element={<RunnersPage />} />
                <Route
                  path="/runners/:runnerId/auth/:provider"
                  element={<RunnerAuthPage />}
                />
                <Route path="/routing" element={<RoutingPage />} />
                <Route path="/events" element={<EventsPage />} />
                <Route path="/events/:id" element={<EventPage />} />
                <Route path="/identities" element={<IdentitiesPage />} />
                <Route path="/projects/new" element={<NewProjectPage />} />
                <Route path="/invites" element={<InvitesPage />} />
                <Route path="/audit" element={<AuditLogPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/settings" element={<SettingsPage />}>
                  {/* `replace`, or Back returns to `/settings` and this
                      redirect fires again — a Back-button trap. */}
                  <Route
                    index
                    element={<Navigate to={DEFAULT_SETTINGS_SECTION} replace />}
                  />
                  <Route path="general" element={<GeneralSection />} />
                  <Route
                    path="integrations"
                    element={<IntegrationsSection />}
                  />
                  <Route path="routing" element={<RoutingSection />} />
                  <Route path="mcp" element={<McpSection />} />
                  <Route path="telemetry" element={<TelemetrySection />} />
                  <Route path="members" element={<MembersSection />} />
                  <Route path="tags" element={<TagsSection />} />
                  <Route path="danger" element={<DangerZoneSection />} />
                  {/* A typo in a bookmark says so, inside the settings
                      chrome, rather than quietly landing somewhere else. */}
                  <Route
                    path="*"
                    element={
                      <Alert variant="warning" data-testid="no-such-section">
                        No such section.
                      </Alert>
                    }
                  />
                </Route>
              </Route>
            </Route>
            <Route path="/style-guide" element={<StyleGuidePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </NotificationProvider>
      </LiveSocketProvider>
    </AuthProvider>
  );
}
