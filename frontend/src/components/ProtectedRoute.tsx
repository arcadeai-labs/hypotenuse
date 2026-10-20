import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import LoadingLabel from "./LoadingLabel";

/**
 * Route guard for authenticated pages. While the first hydration is in flight it
 * renders a loading label — redirecting before `/me` answers would bounce a
 * signed-in user to the sign-in page on every hard refresh. Once settled: no
 * user → `/sign-in`; signed in with zero projects → `/projects/new`, since
 * Hypotenuse is unusable without a tenant. That page is exempt from the
 * redirect, or it would bounce to itself forever.
 * @returns A loading label, a redirect, or the nested route.
 */
export default function ProtectedRoute() {
  const { user, projects, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingLabel block testId="auth-loading" />;
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  if (projects.length === 0 && location.pathname !== "/projects/new") {
    return <Navigate to="/projects/new" replace />;
  }

  return <Outlet />;
}
