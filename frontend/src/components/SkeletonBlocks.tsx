import { skeletonWidth } from "../utils/skeleton";

/** See {@link SkeletonBlocks}. */
export interface SkeletonBlocksProps {
  /** How many card-shaped blocks to draw. */
  count?: number;
  /** The `data-testid` on the wrapper. */
  testId: string;
  /**
   * What a screen reader hears instead of the bars, which are `aria-hidden`.
   * Name the thing being fetched — "Loading tags" rather than "Loading".
   */
  label?: string;
}

/**
 * Card-shaped ghosts for a list whose first read has not answered yet: two bars
 * per block, a name and the meta line under it.
 *
 * The non-table half of the pair — see {@link SkeletonRows} for why they are
 * two components rather than one with a `variant`.
 * @param props - See {@link SkeletonBlocksProps}.
 * @returns The rendered blocks.
 */
export function SkeletonBlocks({
  count = 3,
  testId,
  label = "Loading",
}: SkeletonBlocksProps) {
  return (
    <div className="skeleton-blocks" data-testid={testId} role="status">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: count }, (_, block) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no id.
        <div key={block} className="skeleton-block" aria-hidden="true">
          <span
            className="skeleton"
            style={{ width: skeletonWidth(block, 0) }}
          />
          <span
            className="skeleton"
            style={{ width: skeletonWidth(block, 1) }}
          />
        </div>
      ))}
    </div>
  );
}
