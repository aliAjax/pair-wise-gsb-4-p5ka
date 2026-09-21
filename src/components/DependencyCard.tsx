// 依赖卡片：头部摘要 + 展开后的表达式定位、问题列表、义务证据、人工授权、版本链。
import { useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  FileWarning,
  Gavel,
  History,
  LocateFixed,
  ShieldCheck,
  ShieldQuestion,
  Stamp,
  Trash2,
} from 'lucide-react';
import type { Span } from '../lib/spdx';
import { sliceSpan } from '../lib/spdx';
import { DISTRIBUTION_LABEL, VERDICT_LABEL, type Distribution } from '../lib/policy';
import {
  STATUS_LABEL,
  adjudicate,
  fmtTime,
  latestVersion,
  type Adjudication,
  type Dependency,
  type IssueKind,
} from '../lib/store';
import ExpressionView, { type Highlight } from './ExpressionView';

const ISSUE_ICON: Record<IssueKind, typeof FileWarning> = {
  parse: FileWarning,
  unknown: ShieldQuestion,
  conflict: AlertTriangle,
  forbidden: Ban,
  'missing-evidence': FileWarning,
};

const HL_KIND: Record<IssueKind, Highlight['kind']> = {
  parse: 'parse',
  unknown: 'unknown',
  conflict: 'conflict',
  forbidden: 'forbidden',
  'missing-evidence': 'evidence',
};

interface Props {
  dep: Dependency;
  adj: Adjudication;
  distribution: Distribution;
  expanded: boolean;
  onToggle: () => void;
  onEvidence: (versionN: number, obligationKey: string, value: string) => void;
  onOverride: (versionN: number, author: string, justification: string) => void;
  onClearOverride: (versionN: number) => void;
  onRemove: () => void;
}

export default function DependencyCard({
  dep,
  adj,
  distribution,
  expanded,
  onToggle,
  onEvidence,
  onOverride,
  onClearOverride,
  onRemove,
}: Props) {
  const [focus, setFocus] = useState<Span | null>(null);
  const [author, setAuthor] = useState('');
  const [justification, setJustification] = useState('');
  const latest = latestVersion(dep);

  const highlights: Highlight[] = adj.issues
    .filter((i) => i.span)
    .map((i) => ({ span: i.span as Span, kind: HL_KIND[i.kind] }));

  const badgeText = adj.overridden ? '人工放行' : STATUS_LABEL[adj.status];
  const badgeCls = adj.overridden ? 'st-override' : `st-${adj.status}`;

  const submitOverride = () => {
    if (!justification.trim()) return;
    onOverride(latest.n, author.trim(), justification.trim());
    setAuthor('');
    setJustification('');
  };

  return (
    <article className={`dep-card ${expanded ? 'open' : ''}`} id={`dep-${dep.key}`}>
      <button className="dep-head" onClick={onToggle} type="button">
        <span className={`dep-dot ${badgeCls}`} />
        <span className="dep-name">
          <strong>{dep.name}</strong>
          <small>{dep.spec || '未指定版本'}</small>
        </span>
        <span className="dep-ver">v{latest.n}</span>
        <code className="dep-expr" title={latest.expression}>
          {latest.expression}
        </code>
        <span className={`badge ${badgeCls}`}>{badgeText}</span>
        {adj.issues.length > 0 && <span className="issue-count">{adj.issues.length} 个问题</span>}
        <ChevronDown size={16} className="chev" />
      </button>

      {expanded && (
        <div className="dep-body">
          <section>
            <h4>
              <Gavel size={13} /> 表达式裁决 · {DISTRIBUTION_LABEL[distribution]}
            </h4>
            <ExpressionView expression={latest.expression} highlights={highlights} focus={focus} />
            {adj.evalResult && (
              <div className="leaf-chips">
                {adj.evalResult.perLicense.map((pl, i) => (
                  <span key={i} className={`leaf v-${pl.verdict}`}>
                    <i />
                    {pl.id}
                    <em>{VERDICT_LABEL[pl.verdict]}</em>
                  </span>
                ))}
              </div>
            )}
            {adj.evalResult && adj.verdict !== 'conflict' && adj.evalResult.chosen.length > 0 && (
              <p className="chosen">放行路径：{adj.evalResult.chosen.join(' AND ')}</p>
            )}
            {adj.evalResult && adj.verdict !== 'conflict' && adj.evalResult.conflicts.length > 0 && (
              <p className="chosen muted">备选分支存在冲突（未选择该路径）：{adj.evalResult.conflicts[0].reason}</p>
            )}
          </section>

          {adj.issues.length > 0 && (
            <section>
              <h4>
                <AlertTriangle size={13} /> 待复核问题
              </h4>
              <div className="issues">
                {adj.issues.map((issue, i) => {
                  const Icon = ISSUE_ICON[issue.kind];
                  return (
                    <div className={`issue k-${issue.kind}`} key={i}>
                      <Icon size={15} className="issue-icon" />
                      <div className="issue-main">
                        <p>{issue.message}</p>
                        {issue.span && <code className="issue-frag">{sliceSpan(latest.expression, issue.span)}</code>}
                      </div>
                      {issue.span && (
                        <button type="button" className="ghost sm" onClick={() => setFocus(issue.span ?? null)}>
                          <LocateFixed size={13} /> 定位
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {adj.obligations.length > 0 && (
            <section>
              <h4>
                <ShieldCheck size={13} /> 附条件义务与证据
              </h4>
              {adj.obligations.map((o) => (
                <div className={`obligation ${o.satisfied ? 'done' : ''}`} key={o.key}>
                  <div className="ob-head">
                    {o.satisfied ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                    <strong>{o.label}</strong>
                    <span>{o.desc}</span>
                  </div>
                  <textarea
                    rows={2}
                    placeholder="填写证据，例如 NOTICE 文件路径、源码获取链接、授权合同编号…"
                    value={o.evidence}
                    onChange={(e) => onEvidence(latest.n, o.key, e.target.value)}
                  />
                </div>
              ))}
            </section>
          )}

          <section>
            <h4>
              <Stamp size={13} /> 人工授权
            </h4>
            {latest.override ? (
              <div className="override-card">
                <div className="override-meta">
                  <strong>{latest.override.author || '未署名'}</strong>
                  <time>{fmtTime(latest.override.at)}</time>
                </div>
                <p>{latest.override.justification}</p>
                <button type="button" className="ghost sm" onClick={() => onClearOverride(latest.n)}>
                  撤销授权
                </button>
              </div>
            ) : (
              <div className="override-form">
                <p className="muted-sm">机器裁决未放行时，可经人工授权覆盖；授权依据必填并写入版本链。</p>
                <div className="override-inputs">
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="授权人" />
                  <textarea
                    rows={2}
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="授权依据（必填），例如法务评审结论、商业授权合同编号…"
                  />
                  <button type="button" className="primary sm" disabled={!justification.trim()} onClick={submitOverride}>
                    提交授权并放行
                  </button>
                </div>
              </div>
            )}
          </section>

          <section>
            <h4>
              <History size={13} /> 版本链
            </h4>
            <ol className="chain">
              {[...dep.versions].reverse().map((v) => {
                const a = adjudicate(v, distribution);
                return (
                  <li key={v.n} className={v.n === latest.n ? 'current' : ''}>
                    <span className="dot" />
                    <div className="chain-main">
                      <div className="chain-top">
                        <strong>v{v.n}</strong>
                        <time>{fmtTime(v.importedAt)}</time>
                        <span className={`mini-badge ${a.overridden ? 'st-override' : `st-${a.status}`}`}>
                          {a.overridden ? '人工放行' : STATUS_LABEL[a.status]}
                        </span>
                        {v.n === latest.n && <em>当前</em>}
                      </div>
                      <code>{v.expression}</code>
                      <p>{v.reason}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <div className="dep-foot">
            <button type="button" className="ghost sm danger" onClick={onRemove}>
              <Trash2 size={13} /> 移除依赖（含全部版本）
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
