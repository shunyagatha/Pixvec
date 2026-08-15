/**
 * Where the traced copy goes, as a pure decision.
 *
 * This lives apart from `code.ts` for one reason: `code.ts` calls
 * `figma.showUI` at module load, so it cannot be imported by a test, and the
 * placement arithmetic is exactly the part that was wrong. The first version
 * computed `node.x = source.x + source.width + 40` — but `createNodeFromSvg`
 * parents the new node to the *page*, where coordinates are absolute, while
 * `source.x` is relative to whatever container the source sits in. Those agree
 * only when the source is itself a direct child of the page, which is the one
 * case the manual check happened to use. Nest the same layer in a frame at
 * (300, 50) and the two spaces add together, dropping the copy on top of the
 * original and painting above it, because the page's last child is on top.
 *
 * Returning a decision rather than mutating a node is what makes the four
 * container cases testable without a Figma document. `test/figma-placement.test.ts`
 * covers them.
 */

/** Gap between the original layer and the traced copy, in layer units. */
export const GAP = 40;

/** The parts of a `SceneNode` placement actually depends on. */
export interface PlacementSource {
  /** Position within `parent`'s coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Page-absolute box, or null for a node Figma cannot resolve one for. */
  absoluteBoundingBox: { x: number; y: number; width: number; height: number } | null;
  parent: {
    /** `'NONE'` for a plain frame; anything else reflows its children. */
    layoutMode?: string;
    /** True when the parent can take the new node as a child. */
    canAppend: boolean;
  } | null;
}

export interface Placement {
  /** Move the node into the source's container before positioning it. */
  reparent: boolean;
  x: number;
  y: number;
}

export function placement(source: PlacementSource): Placement {
  const parent = source.parent;

  // An auto-layout parent would immediately reflow the new child into the stack
  // rather than leaving it where it was put, so adopting it there would move the
  // copy somewhere neither we nor the user chose.
  const reflows = parent?.layoutMode !== undefined && parent.layoutMode !== 'NONE';

  // Preferred: put the copy in the source's own container. That makes the two
  // sets of coordinates comparable again, and keeps the pair together in the
  // layer tree, which is where a user looks for it.
  if (parent && parent.canAppend && !reflows) {
    return { reparent: true, x: source.x + source.width + GAP, y: source.y };
  }

  // Otherwise the node stays on the page, where x and y are absolute — so the
  // source has to be described in that same space.
  const box = source.absoluteBoundingBox;
  if (box) return { reparent: false, x: box.x + box.width + GAP, y: box.y };

  // No absolute box is possible for a node Figma declines to measure. Falling
  // back to the source's own space is not provably right, but it is the only
  // information left, and it is still to the right rather than on top.
  return { reparent: false, x: source.x + source.width + GAP, y: source.y };
}
