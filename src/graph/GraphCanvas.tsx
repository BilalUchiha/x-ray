import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AnalysisSession } from '../core/types';
import { boxLabel, edgeAnchors, GraphLayout, TOGGLE_RESERVE, toggleRect, type LayoutLink, type LayoutNode } from './layout';
import { edgeColor, kindColor, THEME } from './theme';
import type { GraphView, ViewNode } from './viewModel';

export interface GraphCanvasProps {
  session: AnalysisSession;
  view: GraphView;
  selectedNodeId: string | null;
  highlighted: Set<string>;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onExpand: (id: string) => void;
  /** Compact rendering for the side-by-side AI layout. */
  compact?: boolean;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const FONT_STACK = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export function GraphCanvas({
  session,
  view,
  selectedNodeId,
  highlighted,
  onSelect,
  onHover,
  onExpand,
  compact = false,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<GraphLayout | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const transformRef = useRef<Transform>({ scale: 1, tx: 0, ty: 0 });
  const viewNodesRef = useRef<Map<string, ViewNode>>(new Map());
  const hoverRef = useRef<string | null>(null);
  const toggleHoverRef = useRef(false);
  const dragRef = useRef<{
    mode: 'pan' | 'node';
    id?: string;
    /** The press landed on the disclosure control rather than the box body. */
    toggle?: boolean;
    startX: number;
    startY: number;
    originTx: number;
    originTy: number;
    moved: boolean;
  } | null>(null);
  const sizeRef = useRef({ width: 800, height: 600 });
  const dirtyRef = useRef(true);
  const fittedRef = useRef(false);
  const focusRef = useRef<{ x: number; y: number } | null>(null);
  const propsRef = useRef({ selectedNodeId, highlighted, compact });
  propsRef.current = { selectedNodeId, highlighted, compact };

  // --- build the layout when the visible set changes ----------------------
  const viewKey = useMemo(
    () => `${view.nodes.map((n) => n.id).join(',')}|${view.edges.map((e) => `${e.source}>${e.target}:${e.kind}`).join(',')}`,
    [view],
  );

  useEffect(() => {
    const { width, height } = sizeRef.current;
    const nodeById = new Map(view.nodes.map((node) => [node.id, node]));
    viewNodesRef.current = nodeById;

    const links: LayoutLink[] = view.edges
      .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind as string, weight: edge.weight }));

    layoutRef.current = new GraphLayout(view.nodes, links, {
      centerX: width / 2,
      centerY: height / 2,
      compact,
      previous: positionsRef.current,
    });
    dirtyRef.current = true;
    // A new shape always deserves a re-fit; the layout already animates, so the
    // camera snapping to it at the same time would fight the movement.
    fittedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  // Dev-only introspection. The map is a canvas, so there is otherwise no way
  // to ask "which box is where" while tuning the layout or writing UI checks.
  // Vite folds this away in a production build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __xray?: unknown }).__xray = {
      layout: () => layoutRef.current,
      transform: () => transformRef.current,
      view: () => viewNodesRef.current,
      size: () => sizeRef.current,
    };
  }, []);

  // --- resize -------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const previous = sizeRef.current;
      sizeRef.current = { width: rect.width, height: rect.height };
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Keep the chart centred on the new canvas and re-fit, otherwise a resize
      // would leave it stranded off-screen.
      const layout = layoutRef.current;
      if (layout && rect.width > 40 && rect.height > 40) {
        const dx = rect.width / 2 - previous.width / 2;
        const dy = rect.height / 2 - previous.height / 2;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) layout.translate(dx, dy);
        layout.setCenter(rect.width / 2, rect.height / 2);
        fittedRef.current = false;
      }
      dirtyRef.current = true;
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /**
   * Frames the chart. The initial view keeps a legibility floor: a big chart is
   * shown from its top at a size you can actually read, and the fit button
   * zooms out to the whole thing when you want the overview.
   */
  const fitView = useCallback((minScale = 0.12, fromTop = false) => {
    const layout = layoutRef.current;
    if (!layout || layout.nodes.length === 0) return;
    const { width, height } = sizeRef.current;
    if (width < 60 || height < 60) return;
    const { minX, minY, maxX, maxY } = layout.bounds();
    const padding = compact ? 40 : 72;
    const scaleX = (width - padding * 2) / Math.max(1, maxX - minX);
    const scaleY = (height - padding * 2) / Math.max(1, maxY - minY);
    const scale = Math.max(minScale, Math.min(1.35, Math.min(scaleX, scaleY)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const ty = fromTop ? padding - minY * scale : height / 2 - cy * scale;
    transformRef.current = { scale, tx: width / 2 - cx * scale, ty };
    dirtyRef.current = true;
  }, [compact]);

  // --- render loop --------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const layout = layoutRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!layout || !ctx) return;

      const settling = !layout.settled;
      if (settling) {
        for (let i = 0; i < 2; i++) layout.step();
        for (const node of layout.nodes) positionsRef.current.set(node.id, { x: node.x, y: node.y });
      }

      if (!fittedRef.current && layout.nodes.length > 0 && sizeRef.current.width > 60 && (layout.settled || layout.alphaValue < 0.4)) {
        fittedRef.current = true;
        fitView(0.5, true);
      }

      // Smooth focus on the selected node.
      const focus = focusRef.current;
      if (focus) {
        const { tx, ty, scale } = transformRef.current;
        const targetTx = sizeRef.current.width / 2 - focus.x * scale;
        const targetTy = sizeRef.current.height / 2 - focus.y * scale;
        if (Math.abs(targetTx - tx) < 0.5 && Math.abs(targetTy - ty) < 0.5) {
          focusRef.current = null;
        } else {
          transformRef.current = { scale, tx: tx + (targetTx - tx) * 0.16, ty: ty + (targetTy - ty) * 0.16 };
        }
        dirtyRef.current = true;
      }

      if (settling || dirtyRef.current || focus) {
        dirtyRef.current = false;
        draw(ctx, layout, sizeRef.current, transformRef.current, viewNodesRef.current, propsRef.current, hoverRef.current);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fitView]);

  // Focus the selected node when selection changes.
  useEffect(() => {
    if (!selectedNodeId) return;
    const node = layoutRef.current?.nodes.find((n) => n.id === selectedNodeId);
    if (node) {
      focusRef.current = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
      dirtyRef.current = true;
    }
  }, [selectedNodeId]);

  useEffect(() => {
    dirtyRef.current = true;
  }, [highlighted, view]);

  // --- interaction --------------------------------------------------------
  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { scale, tx, ty } = transformRef.current;
    return {
      x: (clientX - rect.left - tx) / scale,
      y: (clientY - rect.top - ty) / scale,
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    const layout = layoutRef.current;
    const toggle = layout?.toggleAt(world.x, world.y) ?? null;
    const hit = toggle ?? layout?.nodeAt(world.x, world.y) ?? null;
    capturePointer(event, true);
    if (hit) {
      dragRef.current = {
        mode: 'node',
        id: hit.id,
        toggle: Boolean(toggle),
        startX: event.clientX,
        startY: event.clientY,
        originTx: hit.x,
        originTy: hit.y,
        moved: false,
      };
    } else {
      dragRef.current = {
        mode: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        originTx: transformRef.current.tx,
        originTy: transformRef.current.ty,
        moved: false,
      };
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

      if (drag.mode === 'pan') {
        transformRef.current = { ...transformRef.current, tx: drag.originTx + dx, ty: drag.originTy + dy };
      } else if (drag.id) {
        const { scale } = transformRef.current;
        layoutRef.current?.pin(drag.id, drag.originTx + dx / scale, drag.originTy + dy / scale);
      }
      dirtyRef.current = true;
      return;
    }

    const world = toWorld(event.clientX, event.clientY);
    const layout = layoutRef.current;
    const onToggle = Boolean(layout?.toggleAt(world.x, world.y));
    const hit = layout?.nodeAt(world.x, world.y) ?? null;
    const id = hit?.id ?? null;
    if (id !== hoverRef.current || onToggle !== toggleHoverRef.current) {
      hoverRef.current = id;
      toggleHoverRef.current = onToggle;
      dirtyRef.current = true;
      onHover?.(id);
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = id || onToggle ? 'pointer' : 'grab';
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    capturePointer(event, false);
    if (!drag) return;
    if (drag.mode === 'node' && drag.id) {
      // A click on the disclosure control folds the box; anywhere else
      // selects it. Either way a drag just moves the box.
      if (!drag.moved) {
        if (drag.toggle) onExpand(drag.id);
        else onSelect(drag.id);
      }
    } else if (drag.mode === 'pan' && !drag.moved) {
      onSelect(null);
    }
    dirtyRef.current = true;
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    const hit = layoutRef.current?.nodeAt(world.x, world.y);
    if (hit) onExpand(hit.id);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const { scale, tx, ty } = transformRef.current;
    const factor = Math.exp(-event.deltaY * 0.0016);
    const nextScale = Math.max(0.1, Math.min(3.2, scale * factor));
    const worldX = (mx - tx) / scale;
    const worldY = (my - ty) / scale;
    transformRef.current = {
      scale: nextScale,
      tx: mx - worldX * nextScale,
      ty: my - worldY * nextScale,
    };
    dirtyRef.current = true;
  };

  const zoomBy = (factor: number) => {
    const { width, height } = sizeRef.current;
    const { scale, tx, ty } = transformRef.current;
    const nextScale = Math.max(0.1, Math.min(3.2, scale * factor));
    const worldX = (width / 2 - tx) / scale;
    const worldY = (height / 2 - ty) / scale;
    transformRef.current = { scale: nextScale, tx: width / 2 - worldX * nextScale, ty: height / 2 - worldY * nextScale };
    dirtyRef.current = true;
  };

  void session;

  return (
    <div className="graph-canvas" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          dragRef.current = null;
          if (hoverRef.current || toggleHoverRef.current) {
            hoverRef.current = null;
            toggleHoverRef.current = false;
            dirtyRef.current = true;
            onHover?.(null);
          }
        }}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        style={{ cursor: 'grab', touchAction: 'none' }}
      />
      <div className="graph-controls">
        <button type="button" onClick={() => fitView(0.12, false)} title="Fit the whole chart in view">
          fit
        </button>
        <button type="button" onClick={() => zoomBy(1.25)} title="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(0.8)} title="Zoom out">
          −
        </button>
      </div>
      {view.hiddenNodes > 0 && (
        <div className="graph-note">
          Showing the {view.nodes.length} most connected of {view.totalNodes} components · drill in to reveal more
        </div>
      )}
    </div>
  );
}

/**
 * Pointer capture is a nicety — it keeps a drag alive past the canvas edge.
 * A browser is free to reject it (a pointer that is already gone, an event
 * synthesised by a test), and losing capture must never cost us the click.
 */
function capturePointer(event: React.PointerEvent<HTMLCanvasElement>, capture: boolean): void {
  const target = event.target;
  if (!(target instanceof HTMLCanvasElement)) return;
  try {
    if (capture) target.setPointerCapture(event.pointerId);
    else if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  } catch {
    // Not fatal: without capture a drag simply stops at the canvas edge.
  }
}

// -- drawing ---------------------------------------------------------------

interface DrawProps {
  selectedNodeId: string | null;
  highlighted: Set<string>;
  compact: boolean;
}

function draw(
  ctx: CanvasRenderingContext2D,
  layout: GraphLayout,
  size: { width: number; height: number },
  transform: Transform,
  viewNodes: Map<string, ViewNode>,
  props: DrawProps,
  hovered: string | null,
): void {
  const { width, height } = size;
  const { scale, tx, ty } = transform;
  const hasHighlight = props.highlighted.size > 0;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, width, height);

  // Subtle dot grid for spatial reference while panning.
  drawGrid(ctx, size, transform);

  ctx.translate(tx, ty);
  ctx.scale(scale, scale);

  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  ctx.lineCap = 'round';

  // --- containment spine, drawn first so it sits behind everything --------
  ctx.globalAlpha = hasHighlight ? 0.18 : 0.55;
  ctx.strokeStyle = THEME.borderStrong;
  ctx.lineWidth = 1.4 / scale;
  ctx.beginPath();
  for (const link of layout.links) {
    if (link.kind !== 'contains') continue;
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    // A straight connector reads as "these belong under that one".
    const anchor = edgeAnchors(a, b);
    ctx.moveTo(anchor.ax, anchor.ay);
    ctx.lineTo(anchor.bx, anchor.by);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // --- relationships, batched per kind to keep stroke calls low ----------
  const grouped = new Map<string, Array<{ ax: number; ay: number; bx: number; by: number; weight: number }>>();
  for (const link of layout.links) {
    if (link.kind === 'contains') continue;
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    const anchor = edgeAnchors(a, b);
    const list = grouped.get(link.kind) ?? [];
    list.push({ ax: anchor.ax, ay: anchor.ay, bx: anchor.bx, by: anchor.by, weight: link.weight });
    grouped.set(link.kind, list);
  }

  for (const [kind, list] of grouped) {
    ctx.strokeStyle = edgeColor(kind as never);
    ctx.globalAlpha = hasHighlight ? 0.14 : 0.42;
    for (const edge of list) {
      ctx.lineWidth = 1.2 / scale + Math.min(edge.weight, 4) * 0.2;
      ctx.beginPath();
      ctx.moveTo(edge.ax, edge.ay);
      const mx = (edge.ax + edge.bx) / 2;
      const my = (edge.ay + edge.by) / 2;
      const nx = -(edge.by - edge.ay);
      const ny = edge.bx - edge.ax;
      const len = Math.hypot(nx, ny) || 1;
      const bow = Math.min(24, len * 0.07);
      ctx.quadraticCurveTo(mx + (nx / len) * bow, my + (ny / len) * bow, edge.bx, edge.by);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // --- boxes -------------------------------------------------------------
  for (const node of layout.nodes) {
    const meta = viewNodes.get(node.id);
    if (!meta) continue;
    const isSelected = props.selectedNodeId === node.id;
    const isHovered = hovered === node.id;
    const isHighlighted = props.highlighted.has(node.id);
    const dimmed = hasHighlight && !isHighlighted && !isSelected;
    const color = meta.color ?? kindColor(meta.kind);
    const isMember = meta.kind === 'method' || meta.kind === 'function' || meta.kind === 'constructor' || meta.kind === 'property' || meta.kind === 'field';

    ctx.globalAlpha = dimmed ? 0.2 : 1;

    if (isSelected || isHighlighted) {
      ctx.beginPath();
      roundRect(ctx, node.x - 4, node.y - 4, node.width + 8, node.height + 8, 10);
      ctx.fillStyle = isSelected ? 'rgba(77, 208, 199, 0.16)' : 'rgba(240, 180, 41, 0.14)';
      ctx.fill();
      ctx.strokeStyle = isSelected ? THEME.accent : THEME.warn;
      ctx.lineWidth = 1.6 / scale;
      ctx.stroke();
    }

    // Card body.
    ctx.beginPath();
    roundRect(ctx, node.x, node.y, node.width, node.height, 7);
    ctx.fillStyle = isMember ? withAlpha(color, 0.1) : withAlpha(color, meta.isGroup ? 0.2 : 0.15);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, isHovered ? 1 : meta.isGroup ? 0.85 : 0.7);
    ctx.lineWidth = (meta.isGroup || meta.kind === 'project' ? 1.5 : 1.1) / scale;
    ctx.stroke();

    // Left accent bar so the kind is readable at a glance.
    ctx.beginPath();
    roundRect(ctx, node.x, node.y, Math.min(4, node.width / 4), node.height, 2);
    ctx.fillStyle = withAlpha(color, 0.95);
    ctx.fill();

    const label = boxLabel(meta);
    ctx.font = boxFont(meta);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = dimmed ? 'rgba(230,237,243,0.6)' : isSelected ? THEME.accent : 'rgba(230,237,243,0.92)';
    const textX = node.x + 9;
    const maxTextWidth = node.width - 14 - (meta.childCount ? TOGGLE_RESERVE : 0);
    ctx.fillText(fitText(ctx, label, maxTextWidth), textX, node.y + node.height / 2 + 0.5);

    if (meta.childCount) drawToggle(ctx, node, Boolean(meta.collapsed), color, scale, dimmed);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * The disclosure control: "−" when the box is open, "+" when it is folded
 * shut. Filled in the box's own colour so it reads as part of the card, and
 * lightened while the pointer is over it so it is obviously clickable.
 */
function drawToggle(
  ctx: CanvasRenderingContext2D,
  node: LayoutNode,
  collapsed: boolean,
  color: string,
  scale: number,
  dimmed: boolean,
): void {
  const rect = toggleRect(node);
  ctx.globalAlpha = dimmed ? 0.25 : 1;
  ctx.beginPath();
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 5);
  ctx.fillStyle = withAlpha(color, collapsed ? 0.9 : 0.16);
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.75);
  ctx.lineWidth = 1 / scale;
  ctx.stroke();

  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const arm = Math.min(4, rect.w / 2 - 2);
  ctx.strokeStyle = collapsed ? THEME.bg : withAlpha(color, 0.95);
  ctx.lineWidth = 1.6 / scale;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy);
  ctx.lineTo(cx + arm, cy);
  if (collapsed) {
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function boxFont(meta: ViewNode): string {
  if (meta.kind === 'project' || meta.kind === 'workspace' || meta.kind === 'app') {
    return `600 12px ${FONT_STACK}`;
  }
  if (meta.isGroup) return `600 11.5px ${FONT_STACK}`;
  if (meta.kind === 'method' || meta.kind === 'function' || meta.kind === 'constructor' || meta.kind === 'property' || meta.kind === 'field') {
    return `10.5px ${FONT_STACK}`;
  }
  return `11.5px ${FONT_STACK}`;
}

/** Truncates a label with an ellipsis so it always stays inside its box. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--;
  return `${text.slice(0, cut)}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
}

// -- drawing helpers -------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, size: { width: number; height: number }, transform: Transform): void {
  const spacing = 28 * transform.scale;
  if (spacing < 12) return;
  const offsetX = transform.tx % spacing;
  const offsetY = transform.ty % spacing;
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let x = offsetX; x < size.width; x += spacing) {
    for (let y = offsetY; y < size.height; y += spacing) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

