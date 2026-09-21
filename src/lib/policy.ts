// 策略判断模块
// 职责：按项目分发方式，把解析后的 SPDX 表达式裁决为 允许 / 附条件 / 禁止；
// 检测 AND 组合下的许可证冲突；给出附条件义务目录。
// 输入只依赖解析模块的 AST 与已知许可证表，不关心 UI 与持久化。

import type { ExprNode, LicenseClass, LicenseLeaf, Span } from './spdx';
import { collectLicenses, KNOWN_LICENSES } from './spdx';

// ---------------------------------------------------------------------------
// 分发方式
// ---------------------------------------------------------------------------

export type Distribution = 'internal' | 'saas' | 'binary' | 'source';

export const DISTRIBUTIONS: { id: Distribution; label: string; desc: string }[] = [
  { id: 'internal', label: '内部使用', desc: '不对外分发，仅在公司内部运行' },
  { id: 'saas', label: 'SaaS / 网络服务', desc: '通过网络提供服务，不交付二进制' },
  { id: 'binary', label: '二进制分发', desc: '向客户交付安装包或可执行文件' },
  { id: 'source', label: '源码分发', desc: '向客户交付源代码或衍生作品' },
];

export const DISTRIBUTION_LABEL: Record<Distribution, string> = Object.fromEntries(
  DISTRIBUTIONS.map((d) => [d.id, d.label]),
) as Record<Distribution, string>;

// ---------------------------------------------------------------------------
// 裁决结论与义务目录
// ---------------------------------------------------------------------------

export type Verdict = 'allow' | 'conditional' | 'forbidden';

export const VERDICT_LABEL: Record<Verdict, string> = {
  allow: '允许',
  conditional: '附条件',
  forbidden: '禁止',
};

export interface ObligationDef {
  key: string;
  label: string;
  desc: string;
}

export const OBLIGATIONS: Record<string, ObligationDef> = {
  'notice-retain': { key: 'notice-retain', label: '保留版权与许可声明', desc: '分发的副本中保留原始版权声明与许可证全文' },
  'notice-file': { key: 'notice-file', label: '附带 LICENSE / NOTICE 文本', desc: '随分发物提供许可证文本与 NOTICE 文件（如存在）' },
  'state-changes': { key: 'state-changes', label: '标注修改记录', desc: '对修改过的文件附加显著的修改说明' },
  'source-offer': { key: 'source-offer', label: '提供对应源码', desc: '向接收方提供对应源代码或书面获取要约' },
  'same-license': { key: 'same-license', label: '衍生作品同许可证发布', desc: '衍生作品整体以相同许可证条款发布' },
  'network-source': { key: 'network-source', label: '向网络用户提供源码', desc: '通过网络交互的用户可以获取对应源码' },
  'weak-linking': { key: 'weak-linking', label: '动态链接 / 可替换', desc: '以动态链接方式使用，并允许用户替换该库' },
  attribution: { key: 'attribution', label: '署名', desc: '按许可证要求标注作者与来源' },
  'share-alike': { key: 'share-alike', label: '相同方式共享', desc: '改编作品以相同许可证共享' },
  'commercial-agreement': { key: 'commercial-agreement', label: '商业授权确认', desc: '确认已持有覆盖当前使用方式的商业授权合同' },
};

// ---------------------------------------------------------------------------
// 策略矩阵：许可证类别 × 分发方式 → 结论 + 义务；单许可证可覆盖
// ---------------------------------------------------------------------------

interface PolicyRow {
  verdicts: Record<Distribution, Verdict>;
  obligations: Partial<Record<Distribution, string[]>>;
}

const CLASS_POLICY: Record<LicenseClass, PolicyRow> = {
  permissive: {
    verdicts: { internal: 'allow', saas: 'allow', binary: 'conditional', source: 'conditional' },
    obligations: { binary: ['notice-retain', 'notice-file'], source: ['notice-retain', 'notice-file'] },
  },
  'public-domain': {
    verdicts: { internal: 'allow', saas: 'allow', binary: 'allow', source: 'allow' },
    obligations: {},
  },
  weak: {
    verdicts: { internal: 'allow', saas: 'allow', binary: 'conditional', source: 'conditional' },
    obligations: {
      binary: ['notice-retain', 'source-offer'],
      source: ['notice-retain', 'source-offer', 'same-license'],
    },
  },
  strong: {
    verdicts: { internal: 'allow', saas: 'allow', binary: 'forbidden', source: 'forbidden' },
    obligations: {},
  },
  network: {
    verdicts: { internal: 'allow', saas: 'conditional', binary: 'forbidden', source: 'forbidden' },
    obligations: { saas: ['network-source', 'same-license'] },
  },
  proprietary: {
    verdicts: { internal: 'conditional', saas: 'forbidden', binary: 'forbidden', source: 'forbidden' },
    obligations: { internal: ['commercial-agreement'] },
  },
  other: {
    verdicts: { internal: 'allow', saas: 'conditional', binary: 'conditional', source: 'conditional' },
    obligations: { saas: ['attribution'], binary: ['attribution'], source: ['attribution'] },
  },
};

const LICENSE_OVERRIDES: Record<string, { verdicts?: Partial<Record<Distribution, Verdict>>; obligations?: Partial<Record<Distribution, string[]>> }> = {
  'Apache-2.0': {
    obligations: {
      binary: ['notice-retain', 'notice-file', 'state-changes'],
      source: ['notice-retain', 'notice-file', 'state-changes'],
    },
  },
  'LGPL-2.1-only': { obligations: { binary: ['notice-retain', 'source-offer', 'weak-linking'] } },
  'LGPL-2.1-or-later': { obligations: { binary: ['notice-retain', 'source-offer', 'weak-linking'] } },
  'LGPL-3.0-only': { obligations: { binary: ['notice-retain', 'source-offer', 'weak-linking'] } },
  'LGPL-3.0-or-later': { obligations: { binary: ['notice-retain', 'source-offer', 'weak-linking'] } },
  'EUPL-1.2': {
    verdicts: { internal: 'allow', saas: 'conditional', binary: 'conditional', source: 'conditional' },
    obligations: {
      saas: ['network-source'],
      binary: ['source-offer', 'same-license'],
      source: ['source-offer', 'same-license'],
    },
  },
  'CC-BY-SA-4.0': {
    obligations: { saas: ['attribution', 'share-alike'], binary: ['attribution', 'share-alike'], source: ['attribution', 'share-alike'] },
  },
  'CC-BY-NC-4.0': {
    verdicts: { internal: 'conditional', saas: 'forbidden', binary: 'forbidden', source: 'forbidden' },
    obligations: { internal: ['commercial-agreement'] },
  },
};

export function policyFor(id: string): PolicyRow | null {
  const meta = KNOWN_LICENSES[id];
  if (!meta) return null;
  const base = CLASS_POLICY[meta.cls];
  const ov = LICENSE_OVERRIDES[id];
  return {
    verdicts: { ...base.verdicts, ...ov?.verdicts },
    obligations: { ...base.obligations, ...ov?.obligations },
  };
}

// ---------------------------------------------------------------------------
// 冲突规则：AND 组合下的两两不兼容
// ---------------------------------------------------------------------------

type IdPred = (id: string) => boolean;
const eq = (x: string): IdPred => (id) => id === x;
const oneOf = (...xs: string[]): IdPred => (id) => xs.includes(id);
const GPL_FAMILY: IdPred = (id) => /^(GPL|AGPL)-\d/.test(id);
const COPYLEFT: IdPred = (id) => {
  const m = KNOWN_LICENSES[id];
  return !!m && (m.cls === 'weak' || m.cls === 'strong' || m.cls === 'network');
};

interface ConflictRule {
  a: IdPred;
  b: IdPred;
  reason: string;
}

const CONFLICT_RULES: ConflictRule[] = [
  { a: eq('GPL-2.0-only'), b: oneOf('GPL-3.0-only', 'AGPL-3.0-only'), reason: 'GPL-2.0-only 与 GPL/AGPL v3 互不兼容（缺少“或更高版本”条款）' },
  { a: eq('GPL-2.0-only'), b: eq('Apache-2.0'), reason: 'Apache-2.0 的专利授权与终止条款同 GPL-2.0-only 不兼容' },
  { a: eq('GPL-2.0-only'), b: eq('MPL-2.0'), reason: 'MPL-2.0 默认仅兼容 GPL-3.0，与 GPL-2.0-only 组合冲突' },
  { a: eq('GPL-2.0-only'), b: eq('EUPL-1.2'), reason: 'EUPL-1.2 的兼容列表不包含 GPL-2.0-only' },
  { a: eq('GPL-2.0-only'), b: eq('CC-BY-SA-4.0'), reason: 'CC-BY-SA-4.0 仅单向兼容 GPL-3.0，与 GPL-2.0-only 冲突' },
  { a: eq('MS-PL'), b: GPL_FAMILY, reason: 'MS-PL 与 GPL 系列许可证不兼容' },
  { a: eq('CDDL-1.0'), b: GPL_FAMILY, reason: 'CDDL-1.0 与 GPL 系列许可证互不兼容' },
  { a: oneOf('EPL-1.0', 'EPL-2.0'), b: GPL_FAMILY, reason: 'EPL 与 GPL 系列不能直接合并为同一衍生作品' },
  { a: eq('Proprietary'), b: COPYLEFT, reason: '专有许可证与 copyleft 义务冲突' },
];

export function conflictReason(a: string, b: string): string | null {
  for (const r of CONFLICT_RULES) {
    if ((r.a(a) && r.b(b)) || (r.a(b) && r.b(a))) return r.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 表达式求值：展开为 OR 备选路径，每条路径内取最差结论并检测冲突
// ---------------------------------------------------------------------------

export interface LicenseEval {
  id: string;
  span: Span;
  verdict: Verdict;
  obligations: string[];
}

export interface Conflict {
  aId: string;
  bId: string;
  reason: string;
  spanA: Span;
  spanB: Span;
}

export interface EvalResult {
  verdict: Verdict | 'conflict';
  conflicts: Conflict[];
  obligations: string[];
  perLicense: LicenseEval[];
  chosen: string[];
}

const RANK: Record<Verdict, number> = { allow: 0, conditional: 1, forbidden: 2 };

function toAlternatives(node: ExprNode, cap = 128): LicenseLeaf[][] {
  if (node.kind === 'license') return [[node]];
  const L = toAlternatives(node.left, cap);
  const R = toAlternatives(node.right, cap);
  if (node.kind === 'or') return [...L, ...R].slice(0, cap);
  const out: LicenseLeaf[][] = [];
  for (const a of L) {
    for (const b of R) {
      out.push([...a, ...b]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export function findConflicts(set: LicenseLeaf[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const a = set[i];
      const b = set[j];
      if (a.id === b.id) continue;
      const reason = conflictReason(a.id, b.id);
      if (reason) out.push({ aId: a.id, bId: b.id, reason, spanA: a.span, spanB: b.span });
    }
  }
  return out;
}

function dedupeConflicts(list: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = [c.aId, c.bId].sort().join('|') + c.reason;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evaluateExpression(ast: ExprNode, dist: Distribution): EvalResult {
  const leaves = collectLicenses(ast);
  const perLicense: LicenseEval[] = leaves.map((leaf) => {
    const p = policyFor(leaf.id);
    // 未知标识在裁决层已被拦截，这里兜底为 forbidden
    if (!p) return { id: leaf.id, span: leaf.span, verdict: 'forbidden' as Verdict, obligations: [] };
    return { id: leaf.id, span: leaf.span, verdict: p.verdicts[dist], obligations: p.obligations[dist] ?? [] };
  });

  const conflictsAll: Conflict[] = [];
  let best: { verdict: Verdict; obligations: string[]; ids: string[] } | null = null;

  for (const alt of toAlternatives(ast)) {
    if (alt.some((l) => !KNOWN_LICENSES[l.id])) continue; // 含未知标识的路径不可放行
    const conflicts = findConflicts(alt);
    if (conflicts.length) {
      conflictsAll.push(...conflicts);
      continue;
    }
    let verdict: Verdict = 'allow';
    const obs: string[] = [];
    for (const leaf of alt) {
      const p = policyFor(leaf.id);
      if (!p) continue;
      const v = p.verdicts[dist];
      if (RANK[v] > RANK[verdict]) verdict = v;
      for (const o of p.obligations[dist] ?? []) if (!obs.includes(o)) obs.push(o);
    }
    const ids = alt.map((l) => l.id);
    if (!best || RANK[verdict] < RANK[best.verdict]) best = { verdict, obligations: obs, ids };
  }

  const conflicts = dedupeConflicts(conflictsAll);
  if (!best) return { verdict: 'conflict', conflicts, obligations: [], perLicense, chosen: [] };
  return { verdict: best.verdict, conflicts, obligations: best.obligations, perLicense, chosen: best.ids };
}
