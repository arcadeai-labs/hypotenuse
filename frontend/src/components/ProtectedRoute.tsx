import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { signInFor } from "../utils/returnTo";
import { LoadingLabel } from "./LoadingLabel";

/**
 * The guard for signed-in pages. While the first hydration is in flight it
 * renders a loading label — redirecting before `/me` answers would bounce a
 * signed-in person to the sign-in page on every hard refresh. Once settled,
 * nobody signed in goes to `/sign-in?next=<this page>`, so the page they were
 * opening is where they land after.
 *
 * Having no project is not a reason to redirect: organization membership alone
 * shows no projects, and the organization pages, invites, and account all work
 * without one.
 * @returns A loading label, a redirect, or the nested route.
 */
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingLabel block testId="auth-loading" />;
  if (!user) {
    return (
      <Navigate to={signInFor(location.pathname + location.search)} replace />
    );
  }
  return <Outlet />;
}
