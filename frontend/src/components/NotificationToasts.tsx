import { useNavigate } from "react-router-dom";
import { useNotifications } from "../context/NotificationContext";
import { Alert } from "../ui";

/**
 * The in-app toasts, stacked in the bottom-right corner. Kit `Alert`s rather
 * than a toast component of their own, so they wear the same tokens in both
 * themes with no second set of rules. Clicking one dismisses it and goes where
 * it points.
 * @returns The rendered toast stack, or nothing when there are none.
 */
export default function NotificationToasts() {
  const { toasts, dismissToast } = useNotifications();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className="notification-toasts" data-testid="notification-toasts">
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
          className="notification-toast"
          data-testid={`notification-toast-${toast.id}`}
        >
          <div className="notification-toast-title">{toast.title}</div>
          <div className="text-meta">{toast.body}</div>
        </Alert>
      ))}
    </div>
  );
}
