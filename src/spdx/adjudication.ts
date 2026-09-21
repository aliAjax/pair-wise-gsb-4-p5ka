// 批次裁决模块（ANCHOR-MODULE: adjudication）
// 在策略树之上叠加「版本记录」：证据核验、人工授权覆盖、整批阻断定位、导出闸门。

import { evaluateExpression } from './policy';
import { DISTRIBUTION_LABEL } from './types';
import type {
  Blocker,
  DecisionNode,
  Dependency,
  Distribution,
  Evaluation,
  ObligationKey,
  Status,
  VersionRecord,
} from './types';

export interface DepAdjudication {
  dep: Dependency;
  record: VersionRecord;
  evaluation: Evaluation;
  /** 对外生效状态（覆盖或证据齐全会修正展示状态） */
  effectiveStatus: Status;
  effectiveLabel: string;
  blockers: Blocker[];
  /** 仍缺证据的义务键 */
  missingEvidence: ObligationKey[];
  overridden: boolean;
  released: boolean;
}

const STATUS_TEXT: Record<Status, string> = {
  allow: '允许',
  conditional: '附条件',
  deny: '禁止',
  review: '待复核',
};

function walkChosen(
  node: DecisionNode | null,
  onPath: boolean,
  fn: (node: DecisionNode, onPath: boolean) => void,
) {
  if (!node) return;
  fn(node, onPath);
  if (node.children.length === 2 && !node.conflict) {
    // 无冲突的二元节点即 OR（AND 的冲突/聚合在节点本身上处理，两子都在路径上）
    const isOr = node.reasons.some((r) => r.startsWith('OR '));
    if (isOr) {
      const [l, r] = node.children;
      walkChosen(l, onPath && !!l.chosen, fn);
      walkChosen(r, onPath && !!r.chosen, fn);
      return;
    }
  }
  node.children.forEach((c) => walkChosen(c, onPath, fn));
}

export function adjudicate(dep: Dependency, distribution: Distribution): DepAdjudication {
  const record = dep.versions[dep.versions.length - 1];
  const evaluation = evaluateExpression(record.expression || '', distribution);
  const blockers: Blocker[] = [];
  const missing = new Set<ObligationKey>();

  const base: Blocker = {
    kind: 'parse',
    depId: dep.id,
    depName: dep.name,
    revision: record.revision,
    message: '',
  };

  if (!record.expression.trim()) {
    blockers.push({ ...base, kind: 'parse', message: '该依赖缺少 SPDX 许可证表达式，无法裁决。' });
  } else if (evaluation.parseErrors.length > 0) {
    const err = evaluation.parseErrors[0];
    blockers.push({
      ...base,
      kind: 'parse',
      message: `SPDX 语法错误：${err.message}`,
      span: err.span,
      subText: err.span ? record.expression.slice(err.span.start, err.span.end) : undefined,
    });
  } else {
    // 在「被选中的合规路径」上收集阻断点；未选中的 OR 分支不阻断整批
    walkChosen(evaluation.root, true, (node, onPath) => {
      if (!onPath) return;
      if (node.unknownId) {
        blockers.push({
          ...base,
          kind: 'unknown',
          span: node.span,
          subText: node.text,
          message: `未知标识「${node.unknownId}」：未在许可证/例外表中登记，需人工确认。`,
        });
      }
      if (node.conflict) {
        blockers.push({
          ...base,
          kind: 'conflict',
          span: node.span,
          subText: node.text,
          message: `冲突组合：${node.conflict}`,
        });
      } else if (node.status === 'deny') {
        blockers.push({
          ...base,
          kind: 'deny',
          span: node.span,
          subText: node.text,
          message: `子表达式「${node.text}」在「${DISTRIBUTION_LABEL[distribution]}」下被禁止。`,
        });
      }
      if (node.status === 'conditional') {
        for (const ob of node.obligations) {
          if (!(record.evidence[ob.key] || '').trim()) {
            missing.add(ob.key);
            if (![...blockers].some((b) => b.kind === 'evidence' && b.obligationKey === ob.key)) {
              blockers.push({
                ...base,
                kind: 'evidence',
                span: node.span,
                subText: node.text,
                obligationKey: ob.key,
                message: `附条件义务「${ob.label}」缺少履行证据（定位：${node.text}）。`,
              });
            }
          }
        }
      }
    });
  }

  const overridden = !!record.override && !!record.override.authorizedBy.trim() && !!record.override.basis.trim();
  const rootStatus: Status = evaluation.root?.status ?? 'review';
  const released = overridden || blockers.length === 0;

  let effectiveStatus: Status = rootStatus;
  let effectiveLabel = STATUS_TEXT[rootStatus];
  if (overridden) {
    effectiveStatus = 'allow';
    effectiveLabel = '人工授权放行';
  } else if (blockers.some((b) => b.kind === 'deny' || b.kind === 'conflict')) {
    effectiveStatus = 'deny';
    effectiveLabel = '禁止 · 待复核';
  } else if (blockers.some((b) => b.kind === 'evidence')) {
    effectiveStatus = 'conditional';
    effectiveLabel = '附条件 · 证据待补';
  } else if (blockers.length > 0) {
    effectiveStatus = 'review';
    effectiveLabel = '待复核';
  } else if (rootStatus === 'conditional') {
    effectiveLabel = '附条件 · 已放行';
  }

  return {
    dep,
    record,
    evaluation,
    effectiveStatus,
    effectiveLabel,
    blockers: overridden ? [] : blockers,
    missingEvidence: [...missing],
    overridden,
    released,
  };
}

export interface BatchAdjudication {
  items: DepAdjudication[];
  blockers: Blocker[];
  /** 整批是否停在待复核 */
  held: boolean;
  exportable: boolean;
  counts: { total: number; allow: number; conditional: number; deny: number; review: number };
}

export function adjudicateBatch(deps: Dependency[], distribution: Distribution): BatchAdjudication {
  const items = deps.map((d) => adjudicate(d, distribution));
  const blockers = items.flatMap((i) => i.blockers);
  const counts = { total: items.length, allow: 0, conditional: 0, deny: 0, review: 0 };
  for (const it of items) {
    const key = it.overridden ? 'allow' : it.effectiveStatus;
    if (key === 'allow' || key === 'conditional' || key === 'deny' || key === 'review') counts[key]++;
  }  return {
    items,
    blockers,
    held: blockers.length > 0,
    exportable: deps.length > 0 && blockers.length === 0,
    counts,
  };
}

// ---------------- 导出报告（仅在闸门通过时可调用） ----------------

export function buildReport(deps: Dependency[], distribution: Distribution): string {
  const batch = adjudicateBatch(deps, distribution);
  const lines: string[] = [];
  lines.push('# License Lens 策略裁决报告', '');
  lines.push(`- 项目分发方式：**${DISTRIBUTION_LABEL[distribution]}**`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 依赖总数：${batch.counts.total}（允许 ${batch.counts.allow} / 附条件 ${batch.counts.conditional} / 禁止 ${batch.counts.deny} / 待复核 ${batch.counts.review}）`);
  lines.push(`- 裁决状态：**${batch.exportable ? '整批放行，准予导出' : '整批停在待复核，禁止导出'}**`, '');
  lines.push('## 裁决明细', '');
  lines.push('| 依赖 | 版本 | SPDX 表达式 | 生效结论 | 依据/证据 |', '|---|---|---|---|---|');
  for (const it of batch.items) {
    let basis: string;
    if (it.overridden && it.record.override) {
      basis = `人工授权：${it.record.override.authorizedBy} / ${it.record.override.basis}`;
    } else {
      const ev = Object.entries(it.record.evidence)
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join('；');
      basis = ev || (it.effectiveStatus === 'allow' ? '策略直接放行' : '—');
    }
    lines.push(
      `| ${it.dep.name} | ${it.record.version} | \`${it.record.expression || '（空）'}\` | ${it.effectiveLabel} | ${basis.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('', '## 版本链', '');
  for (const it of batch.items) {
    lines.push(`### ${it.dep.name}`);
    for (const v of it.dep.versions) {
      const tag = v.override ? '（人工授权放行）' : '';
      lines.push(
        `- v${v.revision} · ${v.importedAt} · ${v.version} · \`${v.expression || '（空）'}\` · 导入时分发方式：${DISTRIBUTION_LABEL[v.distribution]}${tag}${v.changeReason ? ` —— ${v.changeReason}` : ''}`,
      );
    }
    lines.push('');
  }
  if (batch.blockers.length) {
    lines.push('## 待复核阻断点', '');
    for (const b of batch.blockers) {
      lines.push(`- **${b.depName} v${b.revision}**（${b.subText ? `子表达式 \`${b.subText}\`：` : ''}${b.message}）`);
    }
  }
  return lines.join('\n');
}
