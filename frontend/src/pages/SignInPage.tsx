import { Link, useSearchParams } from "react-router-dom";
import { AuthCard } from "./AuthCard";

/**
 * Sign in. A `?next=` carried here from a protected page is passed on to
 * sign-up too, so a newcomer still lands where they were going.
 * @returns The page.
 */
export function SignInPage() {
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  return (
    <AuthCard
      mode="sign-in"
      title="Sign in"
      footer={
        <>
          New to Hypotenuse?{" "}
          <Link
            to={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"}
          >
            Create an account
          </Link>
        </>
      }
    />
  );
}
