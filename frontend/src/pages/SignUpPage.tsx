import { Link, useSearchParams } from "react-router-dom";
import { AuthCard } from "./AuthCard";

/**
 * Create an account. A `?next=` is passed back to sign-in the same way.
 * @returns The page.
 */
export function SignUpPage() {
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  return (
    <AuthCard
      mode="sign-up"
      title="Create account"
      footer={
        <>
          Already have an account?{" "}
          <Link
            to={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}
          >
            Sign in
          </Link>
        </>
      }
    />
  );
}
