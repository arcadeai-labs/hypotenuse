import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import NotificationToasts from "./components/NotificationToasts";
import ProtectedRoute from "./components/ProtectedRoute";
import { DEFAULT_SETTINGS_SECTION } from "./components/settings/sections";
import DangerZoneSection from "./components/settings/sections/DangerZoneSection";
import GeneralSection from "./components/settings/sections/GeneralSection";
import McpSection from "./components/settings/sections/McpSection";
import MembersSection from "./components/settings/sections/MembersSection";
import TagsSection from "./components/settings/sections/TagsSection";
import { PublicShell } from "./components/shell/PublicShell";
import { AuthProvider } from "./context/AuthContext";
import { LiveSocketProvider } from "./context/LiveSocketContext";
import { NotificationProvider } from "./context/NotificationContext";
import AccountPage from "./pages/AccountPage";
import AuditLogPage from "./pages/AuditLogPage";
import { PlaceholderPage } from "./pages/app/PlaceholderPage";
import { DocsLayout } from "./pages/docs/DocsLayout";
import { DocsPage } from "./pages/docs/DocsPage";
import InvitesPage from "./pages/InvitesPage";
import { HomePage } from "./pages/marketing/HomePage";
import NewProjectPage from "./pages/NewProjectPage";
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
              <Route element={<AppShell />}>
                <Route
                  path="/home"
                  element={<PlaceholderPage title="Home" />}
                />
                <Route
                  path="/sessions"
                  element={<PlaceholderPage title="Sessions" />}
                />
                <Route
                  path="/runners"
                  element={<PlaceholderPage title="Runners" />}
                />
                <Route
                  path="/routing"
                  element={<PlaceholderPage title="Routing" />}
                />
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
                  <Route path="mcp" element={<McpSection />} />
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
