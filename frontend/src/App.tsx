import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { NotificationToasts } from "./components/NotificationToasts";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { DEFAULT_SETTINGS_SECTION } from "./components/settings/sections";
import { DangerZoneSection } from "./components/settings/sections/DangerZoneSection";
import { GeneralSection } from "./components/settings/sections/GeneralSection";
import { McpServersSection } from "./components/settings/sections/McpServersSection";
import { MembersSection } from "./components/settings/sections/MembersSection";
import { ModelsSection } from "./components/settings/sections/ModelsSection";
import { PromptSectionsSection } from "./components/settings/sections/PromptSectionsSection";
import { SkillLibrarySection } from "./components/settings/sections/SkillLibrarySection";
import { TagsSection } from "./components/settings/sections/TagsSection";
import { PublicShell } from "./components/shell/PublicShell";
import { DOCS_SECTIONS } from "./content/docs/sections";
import { AuthProvider } from "./context/AuthContext";
import { LiveSocketProvider } from "./context/LiveSocketContext";
import { NotificationProvider } from "./context/NotificationContext";
import { StandingProvider } from "./context/StandingContext";
import { AccountPage } from "./pages/AccountPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { ApprovalPage } from "./pages/approvals/ApprovalPage";
import { ApprovalsPage } from "./pages/approvals/ApprovalsPage";
import { BotPage } from "./pages/bots/BotPage";
import { BotPromptPage } from "./pages/bots/BotPromptPage";
import { BotsPage } from "./pages/bots/BotsPage";
import { ChatIndexPage } from "./pages/bots/ChatIndexPage";
import { ChatPage } from "./pages/bots/ChatPage";
import { ConversationPage } from "./pages/bots/ConversationPage";
import { ConversationsPage } from "./pages/bots/ConversationsPage";
import { NewBotPage } from "./pages/bots/NewBotPage";
import { CliActivatePage } from "./pages/cli/CliActivatePage";
import { CliAuthorizePage } from "./pages/cli/CliAuthorizePage";
import { DocsLayout } from "./pages/docs/DocsLayout";
import { DocsPage } from "./pages/docs/DocsPage";
import { EventsPage } from "./pages/EventsPage";
import { HelpInboxPage } from "./pages/help/HelpInboxPage";
import { HelpRequestPage } from "./pages/help/HelpRequestPage";
import { InvitesPage } from "./pages/InvitesPage";
import { HomePage } from "./pages/marketing/HomePage";
import { LegacyBotMemoryRedirect } from "./pages/memory/LegacyBotMemoryRedirect";
import { MemoryDocumentPage } from "./pages/memory/MemoryDocumentPage";
import { MemoryExplorerPage } from "./pages/memory/MemoryExplorerPage";
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
                  <Route path="/approvals" element={<ApprovalsPage />} />
                  <Route
                    path="/approvals/:approvalId"
                    element={<ApprovalPage />}
                  />
                  <Route path="/events" element={<EventsPage />} />
                  <Route path="/help" element={<HelpInboxPage />} />
                  <Route
                    path="/help/:helpRequestId"
                    element={<HelpRequestPage />}
                  />
                  <Route path="/chat" element={<ChatIndexPage />} />
                  <Route path="/bots" element={<BotsPage />} />
                  <Route path="/bots/new" element={<NewBotPage />} />
                  <Route path="/bots/:botId" element={<BotPage />} />
                  <Route
                    path="/bots/:botId/prompt"
                    element={<BotPromptPage />}
                  />
                  <Route path="/bots/:botId/chat" element={<ChatPage />} />
                  <Route
                    path="/bots/:botId/conversations"
                    element={<ConversationsPage />}
                  />
                  <Route
                    path="/bots/:botId/memory"
                    element={<LegacyBotMemoryRedirect />}
                  />
                  <Route
                    path="/bots/:botId/memory/:channelId"
                    element={<LegacyBotMemoryRedirect />}
                  />
                  <Route
                    path="/bots/:botId/memory/:channelId/document"
                    element={<LegacyBotMemoryRedirect document />}
                  />
                  <Route path="/memory" element={<MemoryExplorerPage />} />
                  <Route
                    path="/memory/document"
                    element={<MemoryDocumentPage />}
                  />
                  <Route
                    path="/memory/channels/:channelId"
                    element={<MemoryExplorerPage />}
                  />
                  <Route
                    path="/memory/channels/:channelId/document"
                    element={<MemoryDocumentPage />}
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
                    <Route path="mcp-servers" element={<McpServersSection />} />
                    <Route path="skills" element={<SkillLibrarySection />} />
                    <Route
                      path="prompt-sections"
                      element={<PromptSectionsSection />}
                    />
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
