import { Navigate, Route, Routes } from "react-router-dom";
import { StatusPage } from "./pages/StatusPage";

/**
 * The route table.
 * @returns The routed application.
 */
export function App() {
  return (
    <Routes>
      <Route path="/status" element={<StatusPage />} />
      <Route path="*" element={<Navigate to="/status" replace />} />
    </Routes>
  );
}
