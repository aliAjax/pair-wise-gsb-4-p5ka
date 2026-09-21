import { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import ExpressionTree from './ExpressionTree';
import { store } from '../spdx/storage';
import type { DepAdjudication } from '../spdx/adjudication';
import { DISTRIBUTION_LABEL } from '../spdx/types';

const OBL_HINT: Record<string, string> = {
  'state-changes': '如：NOTICE 中修改声明的文件路径或文档链接',
  'source-available': '如：源码归档地址 / OSS 工单 / offer 链接',
  'copyleft-same-license': '如：整体作品开源仓库地址',
  'network-source': '如：产品「下载源码」页面 URL',
  'commercial-license': '如：商业授权合同编号 / 订阅工单号',
  'attribution-assets': '如：署名页面链接 + 资产用途确认结论',
};

export default function DepDrawer({
  item,
  onClose,
  focusBlockerKey,
}: {
  item: DepAdjudication;
  onClose: () => void;
  focusBlockerKey?: string;
}) {
  const { dep, record } = item;
  const [by, setBy] = useState(record.override?.authorizedBy ?? '');
  const [basis, setBasis] = useState(record.override?.basis ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const obligations = item.evaluation.root ? collectObligations(item) : [];
  const overridden = item.overridden;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <p className="eyebrow">DEPENDENCY REVIEW</p>
            <h2>{dep.name}</h2>
            <span className="drawer-ver">
              当前 v{record.revision} · {record.version} · 导入时分发方式 {DISTRIBUTION_LABEL[record.distribution]}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="drawer-body">
          <section className="drawer-card">
            <h3>SPDX 表达式逐子句裁决</h3>
            <p className="mono-expr">{record.expression || '（表达式为空）'}</p>
            <ExpressionTree root={item.evaluation.root} blockers={item.blockers} />
            <p className="drawer-hint">悬停任一子句查看依据；红色描边即阻断整批的定位点。OR 未选分支会弱化显示，不参与阻断。</p>
          </section>

          {item.blockers.length > 0 && (
            <section className="drawer-card blockers-card">
              <h3>阻断点（{item.blockers.length}）</h3>
              {item.blockers.map((b, i) => (
                <div key={i} className={`blocker-line ${focusBlockerKey === `${b.kind}-${spanKey(b.span)}-${b.obligationKey ?? ''}` ? 'flash' : ''}`}>
                  <i className={`blocker-dot dot-${b.kind}`} />
                  <div>
                    {b.subText && <code>{b.subText}</code>}
                    <p>{b.message}</p>
                  </div>
                </div>
              ))}
            </section>
          )}

          {!overridden && obligations.length > 0 && (
            <section className="drawer-card">
              <h3>附条件义务与履行证据</h3>
              <p className="drawer-hint">义务凭证逐项填写后，该依赖才算「整条表达式放行」。证据随版本保存，新版本不继承。</p>
              {obligations.map((ob) => {
                const value = record.evidence[ob.key] ?? '';
                const filled = value.trim().length > 0;
                return (
                  <div key={ob.key} className="evidence-row">
                    <div className="evidence-head">
                      <span className={`evidence-dot ${filled ? 'ok' : ''}`} />
                      <b>{ob.label}</b>
                      <em>{filled ? '已取证' : '缺证据'}</em>
                    </div>
                    <p>{ob.detail}</p>
                    <input
                      value={value}
                      placeholder={OBL_HINT[ob.key] ?? '凭证路径 / URL / 工单号'}
                      onChange={(e) => store.setEvidence(dep.id, ob.key, e.target.value)}
                    />
                  </div>
                );
              })}
            </section>
          )}

          <section className={`drawer-card ${overridden ? 'override-on' : ''}`}>
            <h3>
              <ShieldCheck size={15} /> 人工授权覆盖
            </h3>
            {overridden && record.override ? (
              <div className="override-box">
                <p>
                  已由 <b>{record.override.authorizedBy}</b> 授权放行（{record.override.at.slice(0, 16).replace('T', ' ')}）
                </p>
                <p className="override-basis">依据：{record.override.basis}</p>
                <button className="secondary" onClick={() => store.clearOverride(dep.id)}>
                  撤销授权，恢复策略裁决
                </button>
              </div>
            ) : (
              <>
                <p className="drawer-hint">
                  仅当策略结论为禁止/待复核，且已取得书面授权时使用。授权人与依据二者必填，缺一项都不能放行。
                </p>
                <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="授权人（姓名 / 法务工号）" />
                <textarea
                  value={basis}
                  onChange={(e) => setBasis(e.target.value)}
                  placeholder="授权依据（合同编号 / 法务批复链接 / 风险接受单号）"
                  rows={2}
                />
                <button
                  className="primary"
                  disabled={!by.trim() || !basis.trim()}
                  onClick={() => store.setOverride(dep.id, by, basis)}
                >
                  填写依据并授权放行
                </button>
              </>
            )}
          </section>

          <section className="drawer-card">
            <h3>版本链（{dep.versions.length}）</h3>
            <ul className="version-chain">
              {[...dep.versions].reverse().map((v) => (
                <li key={v.revision} className={v.revision === record.revision ? 'current' : ''}>
                  <span className="rev">v{v.revision}</span>
                  <div>
                    <b>
                      {v.version} · <code>{v.expression || '（空）'}</code>
                    </b>
                    <small>{v.importedAt.slice(0, 16).replace('T', ' ')}</small>
                    {v.changeReason && <p>{v.changeReason}</p>}
                    {v.override && <p className="chain-override">人工授权：{v.override.authorizedBy}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  );
}

function spanKey(s?: { start: number; end: number }) {
  return s ? `${s.start}:${s.end}` : '';
}

/** 收集被选中路径上、当前仍可能需要履行的义务（去重，保序） */
function collectObligations(item: DepAdjudication) {
  const map = new Map<string, NonNullable<DepAdjudication['evaluation']['root']>['obligations'][number]>();
  const walk = (n: NonNullable<DepAdjudication['evaluation']['root']>, onPath: boolean) => {
    if (onPath) n.obligations.forEach((o) => map.set(o.key, o));
    if (n.children.length === 2) {
      const isOr = n.reasons.some((r) => r.startsWith('OR '));
      n.children.forEach((c) => walk(c, onPath && (!isOr || !!c.chosen)));
    } else {
      n.children.forEach((c) => walk(c, onPath));
    }
  };
  walk(item.evaluation.root!, true);
  return [...map.values()];
}
