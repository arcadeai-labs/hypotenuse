import { Link } from "react-router-dom";
import { AuthCard } from "./AuthCard";

/**
 * Sign in.
 * @returns The page.
 */
export function SignInPage() {
  return (
    <AuthCard
      mode="sign-in"
      title="Sign in"
      footer={
        <>
          New to Hypotenuse? <Link to="/sign-up">Create an account</Link>
        </>
      }
    />
  );
}
