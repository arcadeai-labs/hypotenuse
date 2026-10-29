import { Link } from "react-router-dom";
import { Dropdown } from "../../ui";

/**
 * One menu entry that goes somewhere: a router link while it is offered, a
 * disabled item carrying its reason while it is not. Disabled, never absent,
 * so the menu's shape is the same for every reader.
 * @param props - The destination, label, test id, and refusal.
 * @returns The item.
 */
export function MenuLinkItem({
  to,
  label,
  testId,
  deniedReason,
  onNavigate,
}: {
  to: string;
  label: string;
  testId: string;
  deniedReason?: string;
  onNavigate?: () => void;
}) {
  if (deniedReason) {
    return (
      <Dropdown.Item disabled title={deniedReason} data-testid={testId}>
        {label}
      </Dropdown.Item>
    );
  }
  return (
    <Dropdown.Item as={Link} to={to} onClick={onNavigate} data-testid={testId}>
      {label}
    </Dropdown.Item>
  );
}
