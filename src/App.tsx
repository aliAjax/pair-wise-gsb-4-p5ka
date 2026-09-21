import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Download,
  FileUp,
  History,
  Scale,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { store, SAMPLE_MANIFEST } from './spdx/storage';
import { parseManifest, planImport } from './spdx/importer';
import { adjudicateBatch, buildReport } from './spdx/adjudication';
import { DISTRIBUTIONS, type Blocker, type Status } from './spdx/types';
import DepDrawer from './components/DepDrawer';
import './styles.css';

type Filter = 'all' | Status;

const BADGE: Record<Status, { cls: string; text: string }> = {
  allow: { cls: 'b-allow', text: '允许' },
  conditional: { cls: 'b-cond', text: '附条件' },
  deny: { cls: 'b-deny', text: '禁止' },
  review: { cls: 'b-review', text: '待复核' },
};

const BLOCKER_DOT_LABEL: Record<Blocker['kind'], string> = {
  parse: '语法',
  unknown: '未知标识',
  conflict: '冲突',
  deny: '禁止',
  evidence: '缺证据',
};

function useStore() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getServerSnapshot);
}

export default function App() {
  const persisted = useStore();
  const [manifest, setManifest] = useState(SAMPLE_MANIFEST);
  const [importLog, setImportLog] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openDep, setOpenDep] = useState<string | null>(null);
  const [focusBlocker, setFocusBlocker] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  const batch = useMemo(
    () => adjudicateBatch(persisted.dependencies, persisted.distribution),
    [persisted],
  );

  const items = batch.items.filter((it) => {
    const status = it.overridden ? 'allow' : it.effectiveStatus;
    return (filter === 'all' || status === filter) && it.dep.name.toLowerCase().includes(query.toLowerCase());
  });

  const openItem = batch.items.find((it) => it.dep.id === openDep) ?? null;

  const runImport = () => {
    const entries = parseManifest(manifest);
    if (entries.length === 0) {
      setImportLog(['未解析到任何依赖条目，请检查清单格式。']);
      return;
    }
    const plans = planImport(entries, persisted.dependencies, persisted.distribution, new Date().toISOString());
    store.applyImports(plans);
    const created = plans.filter((p) => p.outcome === 'created').length;
    const revised = plans.filter((p) => p.outcome === 'new-revision').length;
    const unchanged = plans.filter((p) => p.outcome === 'unchanged').length;
    setImportLog([
      `本次解析 ${entries.length} 条：新建 ${created}，生成新版本 ${revised}，无变化 ${unchanged}。`,
      ...plans
        .filter((p) => p.outcome !== 'created')
        .map((p) => `· ${p.entry.name}：${p.reason}`),
    ]);
  };

  const onPickFile = async (file: File) => {
    const text = await file.text();
    setManifest(text);
  };

  const doExport = () => {
    if (!batch.exportable) return;
    const md = buildReport(persisted.dependencies, persisted.distribution);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `license-lens-report-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const jumpBlocker = (b: Blocker) => {
    setOpenDep(b.depId);
    setFocusBlocker(`${b.kind}-${b.span ? `${b.span.start}:${b.span.end}` : ''}-${b.obligationKey ?? ''}`);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Scale size={19} />
          </div>
          <div>
            <strong>License Lens</strong>
            <span>SPDX 策略裁决台</span>
          </div>
        </div>

        <div className="side-label">项目分发方式</div>
        <div className="dist-list">
          {DISTRIBUTIONS.map((d) => (
            <button
              key={d.id}
              className={`dist ${persisted.distribution === d.id ? 'active' : ''}`}
              onClick={() => store.setDistribution(d.id)}
              title={d.hint}
            >
              <span>{d.label}</span>
              {persisted.distribution === d.id && <ChevronRight size={14} />}
            </button>
          ))}
        </div>

        <div className="side-label">导入清单</div>
        <div className="import-box">
          <textarea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            spellCheck={false}
            placeholder={'名称@版本  SPDX 表达式\n例：react@18.3.1 (MIT OR Apache-2.0)'}
          />
          <button className="primary wide" onClick={runImport}>
            <Upload size={15} /> 解析并导入
          </button>
          <button className="ghost wide" onClick={() => fileRef.current?.click()}>
            <FileUp size={15} /> 选择清单文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.json,.csv,.lock,package.json"
            hidden
            onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])}
          />
          <p className="hint">每行一条：<code>名称@版本</code> 后接 SPDX 表达式，支持括号、AND/OR/WITH 与 +；也可粘贴 package.json。</p>
          {importLog.length > 0 && (
            <div className="import-log">
              {importLog.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-foot">
          <button className="ghost wide" onClick={() => store.resetAll()}>
            <History size={14} /> 重置为示例数据
          </button>
          <p className="hint">数据仅保存在浏览器本地，刷新后清单、裁决与版本链保持一致。</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">SPDX POLICY DECISION DESK</p>
            <h1>
              策略裁决 · {DISTRIBUTIONS.find((d) => d.id === persisted.distribution)?.label}
            </h1>
          </div>
          <div className={`export-zone ${batch.exportable ? 'ready' : 'locked'}`}>
            {batch.exportable ? (
              <button className="primary" onClick={doExport}>
                <Download size={16} /> 导出裁决报告
              </button>
            ) : (
              <button className="primary locked-btn" disabled title="整批仍有待复核项">
                <Ban size={16} /> 导出已锁定
              </button>
            )}
            <span>{batch.exportable ? '整条表达式均已放行' : `${batch.blockers.length} 个阻断点未消除`}</span>
          </div>
        </header>

        <section className="stats">
          <Stat label="依赖总数" value={batch.counts.total} icon={<CircleDashed size={16} />} tone="ink" />
          <Stat label="允许" value={batch.counts.allow} icon={<CheckCircle2 size={16} />} tone="good" />
          <Stat label="附条件" value={batch.counts.conditional} icon={<ShieldAlert size={16} />} tone="warn" />
          <Stat label="禁止" value={batch.counts.deny} icon={<Ban size={16} />} tone="bad" />
          <Stat label="待复核" value={batch.counts.review} icon={<AlertTriangle size={16} />} tone="review" />
        </section>

        {batch.held && (
          <div className="hold-banner">
            <AlertTriangle size={17} />
            <div>
              <b>整批停在待复核：</b>
              存在 {batch.blockers.length} 个阻断点（未知标识 / 冲突组合 / 附条件义务缺证据 / 禁止）。逐条定位处理，或对取得书面授权的依赖走人工授权路径并填写依据后，方可导出。
            </div>
          </div>
        )}

        {batch.blockers.length > 0 && (
          <section className="blocker-board">
            <h3>阻断点定位</h3>
            <div className="blocker-grid">
              {batch.blockers.map((b, i) => (
                <button key={i} className="blocker-chip" onClick={() => jumpBlocker(b)}>
                  <span className={`dot dot-${b.kind}`} />
                  <span className="chip-name">{b.depName}</span>
                  <span className="chip-kind">{BLOCKER_DOT_LABEL[b.kind]}</span>
                  {b.subText && <code>{b.subText}</code>}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <div className="filters">
              {(['all', 'allow', 'conditional', 'deny', 'review'] as Filter[]).map((f) => (
                <button key={f} className={filter === f ? 'chip active' : 'chip'} onClick={() => setFilter(f)}>
                  {f === 'all' ? '全部' : BADGE[f].text}
                  <b>{f === 'all' ? batch.counts.total : batch.counts[f as keyof typeof batch.counts]}</b>
                </button>
              ))}
            </div>
            <div className="search">
              <Search size={15} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索依赖…" />
            </div>
          </div>

          <div className="row head">
            <div>依赖</div>
            <div>版本</div>
            <div>SPDX 表达式 / 子句状态</div>
            <div>结论</div>
            <div />
          </div>

          {items.map((it) => {
            const st: Status = it.overridden ? 'allow' : it.effectiveStatus;
            const badge = BADGE[st];
            const key = (b: Blocker) => `${b.kind}-${b.span ? `${b.span.start}:${b.span.end}` : ''}-${b.obligationKey ?? ''}`;
            return (
              <div
                key={it.dep.id + it.record.revision}
                className={`row dep-row ${it.released ? 'released' : 'held'}`}
                onClick={() => {
                  setOpenDep(it.dep.id);
                  setFocusBlocker(undefined);
                }}
              >
                <div className="pkg">
                  <div className="pkgicon">{it.dep.name[0]?.toUpperCase()}</div>
                  <div>
                    <b>{it.dep.name}</b>
                    {it.dep.versions.length > 1 && (
                      <span className="rev-pill">
                        <History size={11} /> v{it.record.revision}
                      </span>
                    )}
                    <span className="pkg-sub">
                      {it.record.changeReason ?? (it.overridden ? '人工授权覆盖' : '已登记依赖')}
                    </span>
                  </div>
                </div>
                <div className="version">{it.record.version}</div>
                <div className="expr-cell">
                  <code className="expr">{it.record.expression || '（空表达式）'}</code>
                  <div className="mini-blockers">
                    {it.blockers.slice(0, 3).map((b, i) => (
                      <span
                        key={i}
                        className={`mini-dot dot-${b.kind} ${focusBlocker === key(b) ? 'flash' : ''}`}
                        title={`${BLOCKER_DOT_LABEL[b.kind]}：${b.subText ? b.subText + ' — ' : ''}${b.message}`}
                      />
                    ))}
                    {it.blockers.length > 3 && <em>+{it.blockers.length - 3}</em>}
                    {it.overridden && <span className="override-tag">已授权</span>}
                  </div>
                </div>
                <div>
                  <span className={`badge ${badge.cls}`}>{it.overridden ? '授权放行' : badge.text}</span>
                </div>
                <div className="row-actions">
                  {openDep !== it.dep.id && <ChevronRight size={16} />}
                  <Trash2
                    size={15}
                    className="trash"
                    onClick={(e) => {
                      e.stopPropagation();
                      store.removeDependency(it.dep.id);
                    }}
                  />
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="empty">没有匹配的依赖，换个筛选条件或导入新清单。</div>}
        </section>
      </main>

      {openItem && (
        <DepDrawer
          item={openItem}
          focusBlockerKey={focusBlocker}
          onClose={() => {
            setOpenDep(null);
            setFocusBlocker(undefined);
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'ink' | 'good' | 'warn' | 'bad' | 'review';
}) {
  return (
    <div className="stat">
      <small>
        {icon} {label}
      </small>
      <b className={`tone-${tone}`}>{value}</b>
    </div>
  );
}
