import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "../ui/cx";

/**
 * A small button that copies `text` to the clipboard and confirms for a moment.
 * @param props - The text to copy, an accessible label, and an optional class.
 * @returns The button.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={cx("copy-button", copied && "is-copied", className)}
      data-testid="copy-button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}
