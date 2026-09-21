import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileDown, PackageOpen, Scale, Search } from 'lucide-react';
import type { Distribution } from './lib/policy';
import {
  STATUS_LABEL,
  adjudicateDependency,
  buildMarkdownReport,
  importEntries,
  loadWorkspace,
  parseManifest,
  removeDependency,
  saveWorkspace,
  seedWorkspace,
  setDistribution,
  setEvidence,
  setOverride,
  summarizeBatch,
  type Adjudication,
  type Dependency,
  type DepStatus,
  type Workspace,
} from './lib/store';
import ImportPanel from './components/ImportPanel';
import DependencyCard from './components/DependencyCard';

type Filter = 'all' | DepStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'allow', label: '允许' },
  { id: 'conditional', label: '附条件' },
  { id: 'forbidden', label: '禁止' },
  { id: 'review', label: '待复核' },
];

interface Row {
  dep: Dependency;
  adj: Adjudication;
}

export default function App() {
  const [ws, setWs] = useState<Workspace>(loadWorkspace);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);

  // 本地持久化：任何状态变化都落盘，刷新后清单、裁决与版本链一致
  useEffect(() => {
    saveWorkspace(ws);
  }, [ws]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const rows: Row[] = useMemo(
    () => ws.dependencies.map((dep) => ({ dep, adj: adjudicateDependency(dep, ws.distribution) })),
    [ws],
  );
  const summary = useMemo(() => summarizeBatch(rows.map((r) => r.adj)), [rows]);
  const blockers = rows.filter((r) => r.adj.status === 'forbidden' || r.adj.status === 'review');

  const visible = rows.filter((r) => {
    if (filter !== 'all' && r.adj.status !== filter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return r.dep.name.toLowerCase().includes(q) || r.dep.versions.some((v) => v.expression.toLowerCase().includes(q));
  });

  const notify = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3600);
  };

  // ---- 工作区操作 -----------------------------------------------------------

  const handleImport = (text: string, reason: string) => {
    const entries = parseManifest(text);
    if (!entries.length) {
      notify('未解析到有效依赖条目');
      return;
    }
    const { ws: next, outcome } = importEntries(ws, entries, reason);
    setWs(next);
    const first = outcome.added[0] ?? outcome.versioned[0];
    if (first) setExpandedKey(first.toLowerCase());
    notify(`导入完成：新增 ${outcome.added.length} · 新版本 ${outcome.versioned.length} · 未变更 ${outcome.unchanged.length}`);
  };

  const handleDistribution = (d: Distribution) => setWs((w) => setDistribution(w, d));

  const handleEvidence = (key: string) => (versionN: number, obligationKey: string, value: string) =>
    setWs((w) => setEvidence(w, key, versionN, obligationKey, value));

  const handleOverride = (key: string) => (versionN: number, author: string, justification: string) => {
    setWs((w) => setOverride(w, key, versionN, { author, justification, at: new Date().toISOString() }));
    notify('人工授权已记录，该依赖视为放行');
  };

  const handleClearOverride = (key: string) => (versionN: number) =>
    setWs((w) => setOverride(w, key, versionN, null));

  const handleRemove = (key: string) => () => {
    setWs((w) => removeDependency(w, key));
    if (expandedKey === key) setExpandedKey(null);
  };

  const handleReset = () => {
    setWs(seedWorkspace());
    setExpandedKey(null);
    notify('已载入示例工作区');
  };

  const handleClear = () => {
    setWs((w) => ({ ...w, dependencies: [] }));
    setExpandedKey(null);
    notify('工作区已清空');
  };

  // ---- 导出：仅当整批放行 ----------------------------------------------------

  const handleExport = () => {
    if (!summary.approved) return;
    const md = buildMarkdownReport(ws, rows);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = 'license-lens-report.md';
    a.click();
    URL.revokeObjectURL(a.href);
    notify('Markdown 裁决报告已导出');
  };

  const jumpTo = (key: string) => {
    setExpandedKey(key);
    requestAnimationFrame(() => {
      document.getElementById(`dep-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // ---- 渲染 -----------------------------------------------------------------

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Scale size={18} />
          </div>
          <div>
            <strong>License Lens</strong>
            <span>SPDX 策略裁决台</span>
          </div>
        </div>
        <ImportPanel
          distribution={ws.distribution}
          onDistribution={handleDistribution}
          onImport={handleImport}
          onResetSample={handleReset}
          onClearAll={handleClear}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">LICENSE POLICY CONSOLE</p>
            <h1>依赖裁决台</h1>
          </div>
          <div className="top-actions">
            <span className={`batch-pill ${summary.approved ? 'ok' : 'hold'}`}>
              {summary.approved ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {summary.approved ? '整批可导出' : '整批待复核'}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!summary.approved}
              onClick={handleExport}
              title={summary.approved ? '导出 Markdown 裁决报告' : `存在未放行依赖：${blockers.map((b) => b.dep.name).join('、') || '—'}`}
            >
              <FileDown size={16} /> 导出 Markdown
            </button>
          </div>
        </header>

        <section className="metrics">
          <div>
            <span>依赖总数</span>
            <strong>{summary.total}</strong>
          </div>
          <div>
            <span>允许{summary.overridden > 0 ? `（含人工 ${summary.overridden}）` : ''}</span>
            <strong className="c-allow">{summary.allow}</strong>
          </div>
          <div>
            <span>附条件</span>
            <strong className="c-conditional">{summary.conditional}</strong>
          </div>
          <div>
            <span>禁止</span>
            <strong className="c-forbidden">{summary.forbidden}</strong>
          </div>
          <div>
            <span>待复核</span>
            <strong className="c-review">{summary.review}</strong>
          </div>
        </section>

        {summary.total > 0 &&
          (summary.approved ? (
            <div className="batch-banner ok">
              <CheckCircle2 size={18} />
              <div>
                <strong>整批已放行</strong>
                <p>所有 SPDX 表达式均已通过裁决或经人工授权覆盖，可以导出报告。</p>
              </div>
            </div>
          ) : (
            <div className="batch-banner hold">
              <AlertTriangle size={18} />
              <div>
                <strong>整批停在待复核：{blockers.length} 个依赖未放行</strong>
                <p>未知标识、冲突组合、策略禁止或缺证据的附条件义务都会阻止导出。点击名称定位到依赖与子表达式。</p>
                <div className="blocker-chips">
                  {blockers.map((b) => (
                    <button key={b.dep.key} type="button" onClick={() => jumpTo(b.dep.key)}>
                      {b.dep.name}
                      <span>{b.adj.overridden ? '人工放行' : STATUS_LABEL[b.adj.status]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>依赖清单</h2>
              <p>共 {summary.total} 个依赖 · 点击行展开裁决详情</p>
            </div>
            <div className="panel-tools">
              <div className="filters">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={filter === f.id ? 'chip active' : 'chip'}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                    {f.id !== 'all' && <em>{rows.filter((r) => r.adj.status === f.id).length}</em>}
                  </button>
                ))}
              </div>
              <div className="search">
                <Search size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索依赖或表达式" />
              </div>
            </div>
          </div>

          <div className="dep-list">
            {visible.map((r) => (
              <DependencyCard
                key={r.dep.key}
                dep={r.dep}
                adj={r.adj}
                distribution={ws.distribution}
                expanded={expandedKey === r.dep.key}
                onToggle={() => setExpandedKey(expandedKey === r.dep.key ? null : r.dep.key)}
                onEvidence={handleEvidence(r.dep.key)}
                onOverride={handleOverride(r.dep.key)}
                onClearOverride={handleClearOverride(r.dep.key)}
                onRemove={handleRemove(r.dep.key)}
              />
            ))}
            {visible.length === 0 && (
              <div className="empty">
                <PackageOpen size={22} />
                {summary.total === 0 ? '工作区为空，从左侧导入依赖清单或载入示例' : '没有匹配当前筛选的依赖'}
              </div>
            )}
          </div>
        </section>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
