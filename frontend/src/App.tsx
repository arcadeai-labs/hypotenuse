import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { PublicShell } from "./components/shell/PublicShell";
import { DOCS_SECTIONS } from "./content/docs/sections";
import { DocsLayout } from "./pages/docs/DocsLayout";
import { DocsPage } from "./pages/docs/DocsPage";
import { HomePage } from "./pages/marketing/HomePage";
import { StatusPage } from "./pages/StatusPage";

/**
 * The route table. Public pages sit in `PublicShell`; the product sits in
 * `AppShell`, whose only page so far is the server's own health. The style
 * guide is a docs page.
 * @returns The routed application.
 */
export function App() {
  return (
    <Routes>
      <Route element={<PublicShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/docs" element={<DocsLayout />}>
          {/* `/docs` is the first page; `replace`, so Back does not loop. */}
          <Route
            index
            element={<Navigate to={DOCS_SECTIONS[0]?.slug ?? ""} replace />}
          />
          <Route path=":slug" element={<DocsPage />} />
        </Route>
      </Route>
      <Route element={<AppShell />}>
        <Route path="/status" element={<StatusPage />} />
      </Route>
      {/* The style guide's old address, from before it was a docs page. */}
      <Route
        path="/style-guide"
        element={<Navigate to="/docs/style-guide" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
