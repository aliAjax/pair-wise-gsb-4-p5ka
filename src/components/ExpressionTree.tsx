import { useState, type ReactNode } from 'react';
import type { Blocker, DecisionNode, Status } from '../spdx/types';

const NODE_CLASS: Record<Status, string> = {
  allow: 'n-allow',
  conditional: 'n-cond',
  deny: 'n-deny',
  review: 'n-review',
};

const NODE_TAG: Record<Status, string> = {
  allow: '允许',
  conditional: '附条件',
  deny: '禁止',
  review: '待复核',
};

function Popover({ node }: { node: DecisionNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`tree-pop-anchor ${NODE_CLASS[node.status]}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {NODE_TAG[node.status]}
      {open && (
        <span className="tree-pop">
          <b>
            {node.text} · {NODE_TAG[node.status]}
          </b>
          {node.reasons.map((r, i) => (
            <span key={i}>{r}</span>
          ))}
          {node.obligations.length > 0 && (
            <span className="pop-obl">触发义务：{node.obligations.map((o) => o.label).join('、')}</span>
          )}
        </span>
      )}
    </span>
  );
}

const spanKey = (s?: { start: number; end: number }) => (s ? `${s.start}:${s.end}` : '');

function Leaf({
  node,
  onPath,
  focus,
}: {
  node: DecisionNode;
  onPath: boolean;
  focus: Set<string>;
}) {
  const blocked = focus.has(spanKey(node.span));
  return (
    <span className={`tree-leaf ${NODE_CLASS[node.status]} ${node.chosen ? 'chosen' : ''} ${onPath ? '' : 'offpath'} ${blocked ? 'focused' : ''}`}>
      {node.text}
      <Popover node={node} />
    </span>
  );
}

function GroupBadge({
  node,
  label,
  focus,
}: {
  node: DecisionNode;
  label: string;
  focus: Set<string>;
}) {
  const blocked = focus.has(spanKey(node.span));
  return (
    <span className={`tree-group-badge ${node.conflict ? 'n-deny' : NODE_CLASS[node.status]} ${blocked ? 'focused' : ''}`}>
      {label}
      <Popover node={node} />
    </span>
  );
}

function render(node: DecisionNode, onPath: boolean, focus: Set<string>): ReactNode {
  if (node.children.length === 0) {
    return <Leaf key={node.span.start} node={node} onPath={onPath} focus={focus} />;
  }
  if (node.children.length === 1) {
    return (
      <span key={node.span.start} className="tree-unary">
        {render(node.children[0], onPath, focus)}
        <GroupBadge node={node} label="WITH 例外" focus={focus} />
      </span>
    );
  }
  const isOr = node.reasons.some((r) => r.startsWith('OR '));
  return (
    <span key={node.span.start} className={`tree-group ${node.conflict ? 'conflict' : ''}`}>
      <span className="tree-bracket">(</span>
      {render(node.children[0], onPath && (!isOr || !!node.children[0].chosen), focus)}
      <em className="tree-op">{isOr ? 'OR' : 'AND'}</em>
      {render(node.children[1], onPath && (!isOr || !!node.children[1].chosen), focus)}
      <span className="tree-bracket">)</span>
      <GroupBadge node={node} label={isOr ? 'OR 组合' : 'AND 组合'} focus={focus} />
    </span>
  );
}

export default function ExpressionTree({
  root,
  blockers = [],
}: {
  root: DecisionNode | null;
  blockers?: Blocker[];
}) {
  if (!root) return <div className="tree-empty">表达式无法解析，请先修正语法错误。</div>;
  const focus = new Set(blockers.filter((b) => b.span).map((b) => spanKey(b.span)));
  return <div className="tree">{render(root, true, focus)}</div>;
}
