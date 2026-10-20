import { Link } from "react-router-dom";
import { AuthCard } from "./AuthCard";

/**
 * Create an account.
 * @returns The page.
 */
export function SignUpPage() {
  return (
    <AuthCard
      mode="sign-up"
      title="Create account"
      footer={
        <>
          Already have an account? <Link to="/sign-in">Sign in</Link>
        </>
      }
    />
  );
}
