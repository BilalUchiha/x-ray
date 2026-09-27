// A top-down hierarchical layout.
//
// The map is drawn as an org chart: the project sits at the top, its projects
// and layers hang beneath it, and each type sits under the layer it belongs to.
// Every node is a small labelled box, so the reader follows a chain of
// containment ("this one is above these two") instead of chasing a hairball.
//
// Children wrap into compact rows rather than stretching into one endless line,
// which is what keeps a layer with thirty types readable instead of a strip of
// unreadable slivers. Links that are not containment are still drawn, but they
// never move a box: structure decides position, relationships are overlays.

import type { ViewNode } from './viewModel';

export interface LayoutNode {
  id: string;
  /** Animated position of the box's top-left corner. */
  x: number;
  y: number;
  /** Where the layout puts the box once the animation finishes. */
  tx: number;
  ty: number;
  width: number;
  height: number;
  /** Depth in the containment tree; 0 is the top of the chart. */
  rank: number;
  /** True while the user has dragged the box somewhere else. */
  pinned?: boolean;
  /**
   * How many boxes the node owns. When it is greater than zero the box carries
   * a disclosure control, whether or not those children are on screen.
   */
  childCount: number;
  /** True when the node's subtree is hidden and the control shows a "+". */
  collapsed: boolean;
}

export interface LayoutLink {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface GraphLayoutOptions {
  centerX: number;
  centerY: number;
  compact?: boolean;
  /** Positions from the previous layout, so boxes glide instead of jumping. */
  previous?: Map<string, { x: number; y: number }>;
}

/** Widest a row of sibling subtrees may grow before it wraps. */
const WRAP_WIDTH = 1180;
/** The side-by-side AI map is much narrower, so rows there are shorter. */
const COMPACT_WRAP_WIDTH = 760;
/** Gap between a parent box and the block of children below it. */
const PARENT_GAP = 46;
/** Gap between wrapped rows of children. */
const SIBLING_GAP = 16;
const ROW_GAP = 24;
const ROOT_GAP = 80;
const DURATION_STEPS = 26;
const CHAR_WIDTH = 6.7;

const MEMBER_KINDS = new Set(['method', 'constructor', 'function', 'property', 'field']);

const TOGGLE_WIDTH = 18;
/** Space reserved on the right of a box for its disclosure control. */
export const TOGGLE_RESERVE = 24;

/**
 * Label rendered inside the box. Grouped boxes always advertise how much they
 * hold; a folded project says how much it is hiding, because that is the only
 * cue left once the whole chart has collapsed.
 */
export function boxLabel(node: ViewNode): string {
  if (node.isGroup) return `${node.label} · ${node.memberCount}`;
  if (node.collapsed && node.childCount && node.kind === 'project') return `${node.label} · ${node.childCount} hidden`;
  return node.label;
}

/**
 * Where a box's disclosure control sits, in world coordinates. Drawn by the
 * canvas and hit-tested by the layout, so the two can never disagree.
 */
export function toggleRect(node: LayoutNode): { x: number; y: number; w: number; h: number } {
  const h = Math.min(TOGGLE_WIDTH, node.height - 8);
  return {
    x: node.x + node.width - TOGGLE_WIDTH - 5,
    y: node.y + (node.height - h) / 2,
    w: TOGGLE_WIDTH,
    h,
  };
}

function boxSize(node: ViewNode, compact: boolean): { width: number; height: number } {
  let height = 28;
  if (node.kind === 'project' || node.kind === 'workspace' || node.kind === 'app') height = 34;
  else if (node.isGroup) height = 28;
  else if (MEMBER_KINDS.has(node.kind)) height = 24;

  // The disclosure control sits inside the box, so every width reserves room
  // for it — otherwise a long label would be truncated to make space for it.
  const reserve = node.childCount ? TOGGLE_RESERVE : 0;
  let minWidth = 86;
  if (node.kind === 'project') minWidth = 112;
  else if (node.isGroup) minWidth = 94;
  else if (MEMBER_KINDS.has(node.kind)) minWidth = 76;
  minWidth += reserve;

  const maxWidth = (compact ? 148 : 204) + reserve;
  const textWidth = Math.round(20 + boxLabel(node).length * CHAR_WIDTH) + reserve;
  return { width: Math.max(minWidth, Math.min(maxWidth, textWidth)), height };
}

interface Size {
  width: number;
  height: number;
}

interface WrappedRow {
  ids: string[];
  width: number;
  height: number;
}

export class GraphLayout {
  readonly nodes: LayoutNode[] = [];
  readonly links: LayoutLink[];
  private readonly byId = new Map<string, LayoutNode>();
  private readonly startX = new Map<string, number>();
  private readonly startY = new Map<string, number>();
  private progress = 0;

  constructor(viewNodes: ViewNode[], links: LayoutLink[], options: GraphLayoutOptions) {
    this.links = links;
    const compact = options.compact ?? false;
    const previous = options.previous;
    const wrapWidth = compact ? COMPACT_WRAP_WIDTH : WRAP_WIDTH;

    const index = new Map(viewNodes.map((node, i) => [node.id, i]));
    const childrenOf = new Map<string, string[]>();
    const parentOf = new Map<string, string>();

    for (const link of links) {
      if (link.kind !== 'contains') continue;
      if (!index.has(link.source) || !index.has(link.target)) continue;
      // First parent wins: the chart is a tree, and duplicates would fan a box out.
      if (parentOf.has(link.target)) continue;
      parentOf.set(link.target, link.source);
      const list = childrenOf.get(link.source) ?? [];
      list.push(link.target);
      childrenOf.set(link.source, list);
    }

    const order = (a: string, b: string) => (index.get(a) ?? 0) - (index.get(b) ?? 0);
    for (const list of childrenOf.values()) list.sort(order);

    const roots = viewNodes
      .map((node) => node.id)
      .filter((id) => !parentOf.has(id))
      .sort(order);

    // A view with no root (or an unexpected cycle) still has to draw: promote the
    // node with the most children, and let the rest stand as their own trees.
    if (roots.length === 0) {
      roots.push(...viewNodes.map((node) => node.id).sort((a, b) => (childrenOf.get(b)?.length ?? 0) - (childrenOf.get(a)?.length ?? 0)));
    }

    // --- depth, for the layout metadata -----------------------------------
    const rankOf = new Map<string, number>();
    const queue = roots.map((id) => ({ id, rank: 0 }));
    const guard = viewNodes.length * 4 + 64;
    for (let i = 0, steps = 0; i < queue.length && steps < guard; i++, steps++) {
      const { id, rank } = queue[i];
      rankOf.set(id, rank);
      for (const child of childrenOf.get(id) ?? []) {
        if (rankOf.has(child)) continue;
        queue.push({ id: child, rank: rank + 1 });
      }
    }
    let maxRank = 0;
    for (const id of index.keys()) maxRank = Math.max(maxRank, rankOf.get(id) ?? 0);
    for (const id of index.keys()) if (!rankOf.has(id)) rankOf.set(id, maxRank + 1);

    const sizes = new Map<string, Size>();
    for (const node of viewNodes) sizes.set(node.id, boxSize(node, compact));

    // --- pass 1: subtree extents, children wrapped into rows --------------
    const rowsOf = new Map<string, WrappedRow[]>();
    const extentOf = new Map<string, Size>();

    const measure = (id: string): Size => {
      const cached = extentOf.get(id);
      if (cached) return cached;
      const size = sizes.get(id)!;
      const kids = childrenOf.get(id) ?? [];
      if (kids.length === 0) {
        const extent = { width: size.width, height: size.height };
        extentOf.set(id, extent);
        return extent;
      }

      const rows: WrappedRow[] = [];
      let current: WrappedRow = { ids: [], width: 0, height: 0 };
      for (const kid of kids) {
        const kidExtent = measure(kid);
        const projected = current.width + (current.ids.length > 0 ? SIBLING_GAP : 0) + kidExtent.width;
        if (current.ids.length > 0 && projected > wrapWidth) {
          rows.push(current);
          current = { ids: [], width: 0, height: 0 };
        }
        current.width += (current.ids.length > 0 ? SIBLING_GAP : 0) + kidExtent.width;
        current.height = Math.max(current.height, kidExtent.height);
        current.ids.push(kid);
      }
      rows.push(current);
      rowsOf.set(id, rows);

      const blockWidth = Math.max(...rows.map((row) => row.width));
      const blockHeight = rows.reduce((sum, row) => sum + row.height, 0) + ROW_GAP * (rows.length - 1);
      const extent = {
        width: Math.max(size.width, blockWidth),
        height: size.height + PARENT_GAP + blockHeight,
      };
      extentOf.set(id, extent);
      return extent;
    };
    for (const root of roots) measure(root);

    // --- pass 2: place each subtree ---------------------------------------
    const targets = new Map<string, { x: number; y: number }>();
    const place = (id: string, left: number, top: number): void => {
      const size = sizes.get(id)!;
      const extent = extentOf.get(id)!;
      // Parent and the block of children below it share the same centre.
      targets.set(id, { x: left + (extent.width - size.width) / 2, y: top });

      const rows = rowsOf.get(id) ?? [];
      let rowTop = top + size.height + PARENT_GAP;
      for (const row of rows) {
        let x = left + (extent.width - row.width) / 2;
        for (const kid of row.ids) {
          const kidExtent = extentOf.get(kid)!;
          place(kid, x, rowTop);
          x += kidExtent.width + SIBLING_GAP;
        }
        rowTop += row.height + ROW_GAP;
      }
    };

    let cursor = 0;
    for (const root of roots) {
      place(root, cursor, 0);
      cursor += extentOf.get(root)!.width + ROOT_GAP;
    }

    // --- centre the whole chart on the viewport ---------------------------
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of viewNodes) {
      const target = targets.get(node.id);
      if (!target) continue;
      const size = sizes.get(node.id)!;
      minX = Math.min(minX, target.x);
      maxX = Math.max(maxX, target.x + size.width);
      minY = Math.min(minY, target.y);
      maxY = Math.max(maxY, target.y + size.height);
    }
    const shiftX = Number.isFinite(minX) ? options.centerX - (minX + maxX) / 2 : 0;
    const shiftY = Number.isFinite(minY) ? options.centerY - (minY + maxY) / 2 : 0;

    for (const node of viewNodes) {
      const target = targets.get(node.id);
      if (!target) continue;
      const size = sizes.get(node.id)!;
      const tx = target.x + shiftX;
      const ty = target.y + shiftY;
      const layoutNode: LayoutNode = {
        id: node.id,
        x: tx,
        y: ty,
        tx,
        ty,
        width: size.width,
        height: size.height,
        rank: rankOf.get(node.id) ?? 0,
        childCount: node.childCount ?? 0,
        collapsed: node.collapsed ?? false,
      };
      this.nodes.push(layoutNode);
      this.byId.set(node.id, layoutNode);
    }

    // --- animation start positions ----------------------------------------
    for (const node of this.nodes) {
      const prev = previous?.get(node.id);
      const parentId = parentOf.get(node.id);
      const parentPrev = parentId ? previous?.get(parentId) : undefined;
      // A brand new box grows out of its parent instead of appearing at random.
      const from = prev ?? parentPrev;
      this.startX.set(node.id, from ? from.x : node.tx);
      this.startY.set(node.id, from ? from.y : node.ty);
      if (from) {
        node.x = from.x;
        node.y = from.y;
      }
    }
  }

  get settled(): boolean {
    return this.progress >= 1;
  }

  get alphaValue(): number {
    return 1 - this.progress;
  }

  step(): void {
    if (this.progress >= 1) return;
    this.progress = Math.min(1, this.progress + 1 / DURATION_STEPS);
    const t = easeOutCubic(this.progress);
    for (const node of this.nodes) {
      if (node.pinned) continue;
      const sx = this.startX.get(node.id) ?? node.tx;
      const sy = this.startY.get(node.id) ?? node.ty;
      node.x = sx + (node.tx - sx) * t;
      node.y = sy + (node.ty - sy) * t;
    }
  }

  /** Moves a box by hand; it stays there until the view is recomposed. */
  pin(id: string, x: number, y: number): void {
    const node = this.byId.get(id);
    if (!node) return;
    node.pinned = true;
    node.x = x;
    node.y = y;
    node.tx = x;
    node.ty = y;
  }

  translate(dx: number, dy: number): void {
    for (const node of this.nodes) {
      node.x += dx;
      node.y += dy;
      node.tx += dx;
      node.ty += dy;
    }
  }

  /** Centres the laid-out chart on a point, used when the canvas resizes. */
  setCenter(centerX: number, centerY: number): void {
    if (this.nodes.length === 0) return;
    const { minX, minY, maxX, maxY } = this.bounds();
    this.translate(centerX - (minX + maxX) / 2, centerY - (minY + maxY) / 2);
  }

  /**
   * The disclosure control under a point, if any. Checked before the plain
   * box hit-test so clicking the "+" folds the box instead of selecting it.
   */
  toggleAt(x: number, y: number): LayoutNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (node.childCount === 0) continue;
      const rect = toggleRect(node);
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return node;
    }
    return null;
  }

  nodeAt(x: number, y: number, slack = 3): LayoutNode | null {
    // Later nodes are painted on top, so hit-test from the top down.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (
        x >= node.x - slack &&
        x <= node.x + node.width + slack &&
        y >= node.y - slack &&
        y <= node.y + node.height + slack
      ) {
        return node;
      }
    }
    return null;
  }

  /** Bounding box of the drawn chart, for fit-to-view. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    return { minX, minY, maxX, maxY };
  }
}

/**
 * Where an edge should meet two boxes. Vertical relationships leave from the
 * bottom of the upper box, horizontal ones from the sides, which keeps a
 * parent → child spine reading as a straight drop.
 */
export function edgeAnchors(
  a: LayoutNode,
  b: LayoutNode,
): { ax: number; ay: number; bx: number; by: number; vertical: boolean } {
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  const clampTo = (value: number, start: number, length: number) =>
    Math.max(start + 6, Math.min(start + length - 6, value));

  if (bcy - acy > a.height * 0.7) {
    return {
      ax: clampTo(bcx, a.x, a.width),
      ay: a.y + a.height,
      bx: clampTo(acx, b.x, b.width),
      by: b.y,
      vertical: true,
    };
  }
  if (acy - bcy > a.height * 0.7) {
    return {
      ax: clampTo(bcx, a.x, a.width),
      ay: a.y,
      bx: clampTo(acx, b.x, b.width),
      by: b.y + b.height,
      vertical: true,
    };
  }
  const toRight = bcx >= acx;
  return {
    ax: toRight ? a.x + a.width : a.x,
    ay: acy,
    bx: toRight ? b.x : b.x + b.width,
    by: bcy,
    vertical: false,
  };
}

function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}
