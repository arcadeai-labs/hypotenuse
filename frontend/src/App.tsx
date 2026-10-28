import { Link, Route, Routes } from "react-router-dom";
import { StatusPage } from "./pages/StatusPage";

/**
 * The route table. The look, the shell, and every other page arrive with the
 * design system; until then the one page is the server's own health.
 * @returns The routed application.
 */
export function App() {
  return (
    <Routes>
      <Route path="/status" element={<StatusPage />} />
      <Route
        path="*"
        element={
          <main>
            <h1>Hypotenuse</h1>
            <p>
              A persistent multiplayer, multichannel agent for your team.{" "}
              <Link to="/status">Server status</Link>
            </p>
          </main>
        }
      />
    </Routes>
  );
}
