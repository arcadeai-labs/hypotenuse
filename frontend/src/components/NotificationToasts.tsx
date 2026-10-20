import { useNavigate } from "react-router-dom";
import Alert from "../ui/Alert";
import { useNotifications } from "../context/NotificationContext";

/**
 * The in-app toasts, stacked in the bottom-right corner.
 *
 * Bootstrap `Alert`s rather than `Toast`s, because the theme styles `Alert` and
 * a second component with its own chrome would need a second set of overrides
 * for no visible difference. They are positioned by inline layout rules — not
 * colors, which the theme owns — because a fixed overlay is the one thing a
 * width-constrained `Container` cannot express.
 * @returns The rendered toast stack.
 */
export default function NotificationToasts() {
  const { toasts, dismissToast } = useNotifications();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: "1rem",
        bottom: "1rem",
        zIndex: 1080,
        maxWidth: "min(24rem, calc(100vw - 2rem))",
      }}
      data-testid="notification-toasts"
    >
      {toasts.map((toast) => (
        <Alert
          key={toast.id}
          variant="info"
          dismissible
          onClose={() => dismissToast(toast.id)}
          onClick={() => {
            dismissToast(toast.id);
            navigate(toast.linkPath);
          }}
          role="status"
          style={{ cursor: "pointer" }}
          data-testid={`notification-toast-${toast.id}`}
        >
          <div className="fw-bold">{toast.title}</div>
          <div className="small">{toast.body}</div>
        </Alert>
      ))}
    </div>
  );
}
