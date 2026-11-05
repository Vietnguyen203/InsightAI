import {
  DASHBOARD_GRID_COLUMNS,
  type DashboardWidget,
  type SemanticQueryResult,
  type WidgetPosition,
} from '@insightai/contracts';

export type Move = 'left' | 'right' | 'up' | 'down' | 'wider' | 'narrower' | 'taller' | 'shorter';

const MAX_HEIGHT = 20;

const overlaps = (a: WidgetPosition, b: WidgetPosition) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Applies a move to one widget on the 12-column grid. Returns null when the result would leave
 * the grid or cover another widget (the move is then simply not allowed).
 */
export function applyMove(
  positions: Map<string, WidgetPosition>,
  id: string,
  move: Move,
): WidgetPosition | null {
  const p = positions.get(id);
  if (!p) return null;
  const next = { ...p };
  switch (move) {
    case 'left':
      next.x -= 1;
      break;
    case 'right':
      next.x += 1;
      break;
    case 'up':
      next.y -= 1;
      break;
    case 'down':
      next.y += 1;
      break;
    case 'wider':
      next.w += 1;
      break;
    case 'narrower':
      next.w -= 1;
      break;
    case 'taller':
      next.h += 1;
      break;
    case 'shorter':
      next.h -= 1;
      break;
  }
  if (next.x < 0 || next.y < 0 || next.w < 1 || next.h < 1 || next.h > MAX_HEIGHT) return null;
  if (next.x + next.w > DASHBOARD_GRID_COLUMNS) return null;
  for (const [other, q] of positions) {
    if (other !== id && overlaps(next, q)) return null;
  }
  return next;
}

/** Reading order for small screens and screen readers: top to bottom, then left to right. */
export const byPosition = (a: { position: WidgetPosition }, b: { position: WidgetPosition }) =>
  a.position.y - b.position.y || a.position.x - b.position.x;

/** Metric versions that changed since the widget was saved ("v1 → v2"). */
export function changedVersions(widget: DashboardWidget, result: SemanticQueryResult | undefined) {
  if (!result) return [];
  const saved = new Map(widget.savedMetricVersions.map((m) => [m.key, m.version]));
  return result.metrics
    .filter((m) => saved.has(m.key) && saved.get(m.key) !== m.version)
    .map((m) => ({ key: m.key, from: saved.get(m.key)!, to: m.version }));
}
