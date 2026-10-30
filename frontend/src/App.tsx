import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { NotificationToasts } from "./components/NotificationToasts";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { DEFAULT_SETTINGS_SECTION } from "./components/settings/sections";
import { DangerZoneSection } from "./components/settings/sections/DangerZoneSection";
import { GeneralSection } from "./components/settings/sections/GeneralSection";
import { MembersSection } from "./components/settings/sections/MembersSection";
import { ModelsSection } from "./components/settings/sections/ModelsSection";
import { TagsSection } from "./components/settings/sections/TagsSection";
import { PublicShell } from "./components/shell/PublicShell";
import { DOCS_SECTIONS } from "./content/docs/sections";
import { AuthProvider } from "./context/AuthContext";
import { LiveSocketProvider } from "./context/LiveSocketContext";
import { NotificationProvider } from "./context/NotificationContext";
import { StandingProvider } from "./context/StandingContext";
import { AccountPage } from "./pages/AccountPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { BotPage } from "./pages/bots/BotPage";
import { BotsPage } from "./pages/bots/BotsPage";
import { ConversationPage } from "./pages/bots/ConversationPage";
import { ConversationsPage } from "./pages/bots/ConversationsPage";
import { NewBotPage } from "./pages/bots/NewBotPage";
import { CliActivatePage } from "./pages/cli/CliActivatePage";
import { CliAuthorizePage } from "./pages/cli/CliAuthorizePage";
import { DocsLayout } from "./pages/docs/DocsLayout";
import { DocsPage } from "./pages/docs/DocsPage";
import { InvitesPage } from "./pages/InvitesPage";
import { HomePage } from "./pages/marketing/HomePage";
import { NewOrganizationPage } from "./pages/NewOrganizationPage";
import { NewProjectPage } from "./pages/NewProjectPage";
import { OrganizationAuditPage } from "./pages/organization/OrganizationAuditPage";
import { OrganizationMembersPage } from "./pages/organization/OrganizationMembersPage";
import { OrganizationPage } from "./pages/organization/OrganizationPage";
import { OrganizationProjectsPage } from "./pages/organization/OrganizationProjectsPage";
import { OrganizationSettingsPage } from "./pages/organization/OrganizationSettingsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { StatusPage } from "./pages/StatusPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { Alert } from "./ui";

/**
 * The route table. Public pages, sign-in, and sign-up sit in `PublicShell`;
 * the product sits in `AppShell`, behind {@link ProtectedRoute} — the one
 * place that decides where a signed-out visitor goes. The server's health
 * stays readable signed out. The style guide is a docs page.
 *
 * The whole tree sits inside the session, standing, live socket, and
 * notification providers, because the shell reads all four on every page.
 * @returns The routed application.
 */
export function App() {
  return (
    <AuthProvider>
      <StandingProvider>
        <LiveSocketProvider>
          <NotificationProvider>
            <NotificationToasts />
            <Routes>
              <Route element={<PublicShell />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/docs" element={<DocsLayout />}>
                  {/* `/docs` is the first page; `replace`, so Back does not loop. */}
                  <Route
                    index
                    element={
                      <Navigate to={DOCS_SECTIONS[0]?.slug ?? ""} replace />
                    }
                  />
                  <Route path=":slug" element={<DocsPage />} />
                </Route>
                <Route path="/sign-in" element={<SignInPage />} />
                <Route path="/sign-up" element={<SignUpPage />} />
                <Route path="/verify-email" element={<VerifyEmailPage />} />
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
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/invites" element={<InvitesPage />} />
                  <Route path="/audit" element={<AuditLogPage />} />
                  <Route path="/bots" element={<BotsPage />} />
                  <Route path="/bots/new" element={<NewBotPage />} />
                  <Route path="/bots/:botId" element={<BotPage />} />
                  <Route
                    path="/bots/:botId/conversations"
                    element={<ConversationsPage />}
                  />
                  <Route
                    path="/conversations"
                    element={<ConversationsPage />}
                  />
                  <Route
                    path="/conversations/:conversationId"
                    element={<ConversationPage />}
                  />
                  <Route path="/projects/new" element={<NewProjectPage />} />
                  <Route
                    path="/organizations/new"
                    element={<NewOrganizationPage />}
                  />
                  <Route path="/settings" element={<SettingsPage />}>
                    <Route
                      index
                      element={
                        <Navigate to={DEFAULT_SETTINGS_SECTION} replace />
                      }
                    />
                    <Route path="general" element={<GeneralSection />} />
                    <Route path="models" element={<ModelsSection />} />
                    <Route path="members" element={<MembersSection />} />
                    <Route path="tags" element={<TagsSection />} />
                    <Route path="danger" element={<DangerZoneSection />} />
                    <Route
                      path="*"
                      element={
                        <Alert variant="warning" data-testid="no-such-section">
                          No such section.
                        </Alert>
                      }
                    />
                  </Route>
                  <Route path="/organization" element={<OrganizationPage />}>
                    <Route index element={<Navigate to="projects" replace />} />
                    <Route
                      path="projects"
                      element={<OrganizationProjectsPage />}
                    />
                    <Route
                      path="members"
                      element={<OrganizationMembersPage />}
                    />
                    <Route
                      path="settings"
                      element={<OrganizationSettingsPage />}
                    />
                    <Route path="audit" element={<OrganizationAuditPage />} />
                  </Route>
                </Route>
              </Route>
              {/* The style guide's old address, from before it was a docs page. */}
              <Route
                path="/style-guide"
                element={<Navigate to="/docs/style-guide" replace />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </NotificationProvider>
        </LiveSocketProvider>
      </StandingProvider>
    </AuthProvider>
  );
}
