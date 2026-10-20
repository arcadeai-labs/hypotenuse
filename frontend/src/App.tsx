import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { PublicShell } from "./components/shell/PublicShell";
import { PlaceholderPage } from "./pages/app/PlaceholderPage";
import { DocsLayout } from "./pages/docs/DocsLayout";
import { DocsPage } from "./pages/docs/DocsPage";
import { HomePage } from "./pages/marketing/HomePage";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { StatusPage } from "./pages/StatusPage";
import { StyleGuidePage } from "./pages/StyleGuidePage";

/**
 * The route table. Public pages sit in `PublicShell`; the product sits in
 * `AppShell`, which gains its sign-in gate when sessions exist.
 * @returns The routed application.
 */
export function App() {
  return (
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
        <Route path="/home" element={<PlaceholderPage title="Home" />} />
        <Route
          path="/sessions"
          element={<PlaceholderPage title="Sessions" />}
        />
        <Route path="/runners" element={<PlaceholderPage title="Runners" />} />
        <Route path="/routing" element={<PlaceholderPage title="Routing" />} />
        <Route
          path="/settings"
          element={<PlaceholderPage title="Settings" />}
        />
        <Route path="/status" element={<StatusPage />} />
      </Route>
      <Route path="/style-guide" element={<StyleGuidePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
