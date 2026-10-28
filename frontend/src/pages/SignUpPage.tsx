import { Link, useSearchParams } from "react-router-dom";
import { safeNext } from "../utils/returnTo";
import { AuthCard } from "./AuthCard";

/**
 * Create an account. Sign-up creates an organization named after the person,
 * with them as its owner, and a first project in it where they are admin. A
 * safe `?next=` is passed back to sign-in the same way.
 * @returns The page.
 */
export function SignUpPage() {
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  return (
    <AuthCard
      mode="sign-up"
      title="Create account"
      footer={
        <>
          Already have an account?{" "}
          <Link
            to={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}
            data-testid="sign-in-link"
          >
            Sign in
          </Link>
        </>
      }
    />
  );
}
