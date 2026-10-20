import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { signInFor } from "../utils/returnTo";
import LoadingLabel from "./LoadingLabel";

/** Signed-in pages that work without any project. */
const PROJECTLESS_PATHS = new Set([
  "/projects/new",
  "/invites",
  "/account",
  "/cli/authorize",
  "/cli/activate",
]);

/**
 * Route guard for authenticated pages. While the first hydration is in flight it
 * renders a loading label — redirecting before `/me` answers would bounce a
 * signed-in user to the sign-in page on every hard refresh. Once settled: no
 * user → `/sign-in`; signed in with zero projects → `/projects/new`, since
 * Hypotenuse is unusable without a tenant. {@link PROJECTLESS_PATHS} are exempt:
 * the new-project page itself, or it would bounce to itself forever; and the
 * invitations and account pages, because an invite is addressed to an e-mail,
 * not a tenant — someone removed from their last project must still be able to
 * accept the invite that gives them one. The CLI approval pages are exempt
 * for the same reason: signing a terminal in is about the person, not a project.
 *
 * A signed-out visitor is sent to `/sign-in?next=<this page>`, so the page they
 * were opening — above all the CLI's approval link — is where they land after.
 * @returns A loading label, a redirect, or the nested route.
 */
export default function ProtectedRoute() {
  const { user, projects, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingLabel block testId="auth-loading" />;
  }

  if (!user) {
    return (
      <Navigate to={signInFor(location.pathname + location.search)} replace />
    );
  }

  if (projects.length === 0 && !PROJECTLESS_PATHS.has(location.pathname)) {
    return <Navigate to="/projects/new" replace />;
  }

  return <Outlet />;
}
