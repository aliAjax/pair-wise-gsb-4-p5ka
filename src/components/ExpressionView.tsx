// 表达式视图：把 SPDX 表达式按问题 span 分段高亮，支持“定位”脉冲。
import type { Span } from '../lib/spdx';

export type HighlightKind = 'parse' | 'unknown' | 'conflict' | 'forbidden' | 'evidence';

export interface Highlight {
  span: Span;
  kind: HighlightKind;
}

const PRIORITY: Record<HighlightKind, number> = {
  parse: 4,
  unknown: 4,
  conflict: 3,
  forbidden: 2,
  evidence: 1,
};

export default function ExpressionView({
  expression,
  highlights,
  focus,
}: {
  expression: string;
  highlights: Highlight[];
  focus: Span | null;
}) {
  const n = expression.length;
  const cls: (HighlightKind | null)[] = new Array<HighlightKind | null>(n).fill(null);
  for (const h of highlights) {
    for (let i = Math.max(0, h.span.start); i < Math.min(h.span.end, n); i++) {
      const cur = cls[i];
      if (!cur || PRIORITY[h.kind] > PRIORITY[cur]) cls[i] = h.kind;
    }
  }
  const inFocus = new Array<boolean>(n).fill(false);
  if (focus) {
    for (let i = Math.max(0, focus.start); i < Math.min(focus.end, n); i++) inFocus[i] = true;
  }

  const segs: { text: string; cls: HighlightKind | null; focus: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const c = expression[i];
    const k = cls[i];
    const f = inFocus[i];
    const last = segs[segs.length - 1];
    if (last && last.cls === k && last.focus === f) last.text += c;
    else segs.push({ text: c, cls: k, focus: f });
  }

  return (
    <code className="expr-view">
      {segs.map((s, i) =>
        s.cls || s.focus ? (
          <mark key={i} className={[s.cls ? `hl-${s.cls}` : '', s.focus ? 'hl-focus' : ''].filter(Boolean).join(' ')}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </code>
  );
}
