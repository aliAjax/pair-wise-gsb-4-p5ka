// 本地持久化与裁决编排模块
// 职责：工作区状态（清单 + 版本链 + 证据 + 人工授权）的 localStorage 读写；
// 导入时维护版本链；把「解析结果 + 策略结论 + 已存证据/授权」合成为依赖状态。

import type { ParseResult, Span } from './spdx';
import { parseExpression } from './spdx';
import type { Distribution, EvalResult, Verdict } from './policy';
import { DISTRIBUTION_LABEL, evaluateExpression, OBLIGATIONS } from './policy';

// ---------------------------------------------------------------------------
// 状态模型
// ---------------------------------------------------------------------------

export interface OverrideRecord {
  author: string;
  justification: string;
  at: string;
}

export interface DepVersion {
  n: number;
  expression: string;
  reason: string;
  importedAt: string;
  evidence: Record<string, string>;
  override: OverrideRecord | null;
}

export interface Dependency {
  key: string;
  name: string;
  spec: string;
  versions: DepVersion[];
}

export interface Workspace {
  distribution: Distribution;
  dependencies: Dependency[];
  updatedAt: string;
}

const STORAGE_KEY = 'license-lens:workspace:v1';
const DISTRIBUTION_IDS: Distribution[] = ['internal', 'saas', 'binary', 'source'];

export function latestVersion(dep: Dependency): DepVersion {
  return dep.versions[dep.versions.length - 1];
}

// ---------------------------------------------------------------------------
// localStorage 读写（刷新后清单、裁决与版本链保持一致）
// ---------------------------------------------------------------------------

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const ws = normalize(JSON.parse(raw));
      if (ws) return ws;
    }
  } catch {
    // 数据损坏时回退到示例工作区
  }
  return seedWorkspace();
}

export function saveWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...ws, updatedAt: new Date().toISOString() }));
  } catch {
    // 存储不可用时静默失败，界面状态仍然可用
  }
}

function normalize(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (!Array.isArray(w.dependencies)) return null;
  const distribution = DISTRIBUTION_IDS.includes(w.distribution as Distribution)
    ? (w.distribution as Distribution)
    : 'saas';
  const dependencies: Dependency[] = [];
  for (const d of w.dependencies as unknown[]) {
    if (!d || typeof d !== 'object') continue;
    const dep = d as Record<string, unknown>;
    if (typeof dep.name !== 'string' || !Array.isArray(dep.versions) || dep.versions.length === 0) continue;
    const versions: DepVersion[] = (dep.versions as unknown[]).map((v, i) => {
      const ver = (v ?? {}) as Record<string, unknown>;
      const ov = ver.override as Record<string, unknown> | null | undefined;
      return {
        n: typeof ver.n === 'number' ? ver.n : i + 1,
        expression: String(ver.expression ?? ''),
        reason: String(ver.reason ?? ''),
        importedAt: String(ver.importedAt ?? ''),
        evidence: ver.evidence && typeof ver.evidence === 'object' ? (ver.evidence as Record<string, string>) : {},
        override:
          ov && typeof ov.justification === 'string' && ov.justification.trim()
            ? { author: String(ov.author ?? ''), justification: ov.justification, at: String(ov.at ?? '') }
            : null,
      };
    });
    dependencies.push({
      key: typeof dep.key === 'string' ? dep.key : dep.name.toLowerCase(),
      name: dep.name,
      spec: typeof dep.spec === 'string' ? dep.spec : '',
      versions,
    });
  }
  return { distribution, dependencies, updatedAt: String(w.updatedAt ?? '') };
}

// ---------------------------------------------------------------------------
// 清单解析（文本 / CSV / package.json / JSON 数组）
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  name: string;
  spec: string;
  expression: string;
}

export function parseManifest(text: string): ManifestEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data: unknown = JSON.parse(trimmed);
      if (Array.isArray(data)) {
        return data
          .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as Record<string, unknown>).name === 'string')
          .map((d) => ({
            name: String(d.name),
            spec: typeof d.version === 'string' ? d.version : '',
            expression: typeof d.license === 'string' && d.license.trim() ? d.license.trim() : 'NOASSERTION',
          }));
      }
      if (data && typeof data === 'object') {
        const pkg = data as Record<string, unknown>;
        const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
        return Object.entries(deps).map(([name, range]) => ({
          name,
          spec: String(range),
          expression: 'NOASSERTION', // package.json 不含许可证信息，标记为未声明
        }));
      }
    } catch {
      // 不是合法 JSON，按行解析
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map(parseLine)
    .filter((e): e is ManifestEntry => !!e);
}

function parseLine(line: string): ManifestEntry | null {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;
  // CSV：name, version, EXPR
  if (s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) return { name: parts[0], spec: parts[1], expression: parts.slice(2).join(', ') };
    if (parts.length === 2) {
      return /^[\d^~>=<]/.test(parts[1])
        ? { name: parts[0], spec: parts[1], expression: 'NOASSERTION' }
        : { name: parts[0], spec: '', expression: parts[1] };
    }
  }
  // 行格式：name@version EXPR ｜ name EXPR ｜ name
  const wsIdx = s.search(/\s/);
  const head = wsIdx > 0 ? s.slice(0, wsIdx) : s;
  const expr = wsIdx > 0 ? s.slice(wsIdx).trim() : '';
  let name = head;
  let spec = '';
  const at = head.startsWith('@') ? head.indexOf('@', 1) : head.indexOf('@');
  if (at > 0) {
    name = head.slice(0, at);
    spec = head.slice(at + 1);
  }
  return { name, spec, expression: expr || 'NOASSERTION' };
}

// ---------------------------------------------------------------------------
// 导入：新依赖建 v1；已裁决依赖再次导入只追加带原因的新版本，绝不原地改写
// ---------------------------------------------------------------------------

export interface ImportOutcome {
  added: string[];
  versioned: string[];
  unchanged: string[];
}

export function importEntries(ws: Workspace, entries: ManifestEntry[], reason: string): { ws: Workspace; outcome: ImportOutcome } {
  const now = new Date().toISOString();
  const outcome: ImportOutcome = { added: [], versioned: [], unchanged: [] };
  let dependencies = [...ws.dependencies];

  for (const e of entries) {
    const key = e.name.toLowerCase();
    const existing = dependencies.find((d) => d.key === key);
    if (!existing) {
      dependencies = [
        ...dependencies,
        {
          key,
          name: e.name,
          spec: e.spec,
          versions: [{ n: 1, expression: e.expression, reason: reason || '首次导入', importedAt: now, evidence: {}, override: null }],
        },
      ];
      outcome.added.push(e.name);
      continue;
    }
    const latest = latestVersion(existing);
    if (latest.expression.trim() === e.expression.trim()) {
      outcome.unchanged.push(e.name);
      continue;
    }
    const next: DepVersion = {
      n: latest.n + 1,
      expression: e.expression,
      reason: reason || `表达式变更：${latest.expression} → ${e.expression}`,
      importedAt: now,
      evidence: {},
      override: null,
    };
    dependencies = dependencies.map((d) =>
      d.key === key ? { ...d, spec: e.spec || d.spec, versions: [...d.versions, next] } : d,
    );
    outcome.versioned.push(e.name);
  }
  return { ws: { ...ws, dependencies }, outcome };
}

// ---------------------------------------------------------------------------
// 工作区操作（纯函数，返回新工作区）
// ---------------------------------------------------------------------------

export function setDistribution(ws: Workspace, distribution: Distribution): Workspace {
  return { ...ws, distribution };
}

export function setEvidence(ws: Workspace, depKey: string, versionN: number, obligationKey: string, value: string): Workspace {
  return mapVersion(ws, depKey, versionN, (v) => ({ ...v, evidence: { ...v.evidence, [obligationKey]: value } }));
}

export function setOverride(ws: Workspace, depKey: string, versionN: number, override: OverrideRecord | null): Workspace {
  return mapVersion(ws, depKey, versionN, (v) => ({ ...v, override }));
}

export function removeDependency(ws: Workspace, depKey: string): Workspace {
  return { ...ws, dependencies: ws.dependencies.filter((d) => d.key !== depKey) };
}

function mapVersion(ws: Workspace, depKey: string, versionN: number, fn: (v: DepVersion) => DepVersion): Workspace {
  return {
    ...ws,
    dependencies: ws.dependencies.map((d) =>
      d.key === depKey ? { ...d, versions: d.versions.map((v) => (v.n === versionN ? fn(v) : v)) } : d,
    ),
  };
}

// ---------------------------------------------------------------------------
// 裁决编排：解析 + 策略 + 证据 + 人工授权 → 依赖状态
// ---------------------------------------------------------------------------

export type DepStatus = 'allow' | 'conditional' | 'forbidden' | 'review';

export const STATUS_LABEL: Record<DepStatus, string> = {
  allow: '允许',
  conditional: '附条件',
  forbidden: '禁止',
  review: '待复核',
};

export type IssueKind = 'parse' | 'unknown' | 'conflict' | 'forbidden' | 'missing-evidence';

export interface Issue {
  kind: IssueKind;
  message: string;
  span?: Span;
  obligationKey?: string;
}

export interface ObligationState {
  key: string;
  label: string;
  desc: string;
  evidence: string;
  satisfied: boolean;
}

export interface Adjudication {
  status: DepStatus;
  verdict: Verdict | 'conflict' | 'invalid';
  issues: Issue[];
  obligations: ObligationState[];
  overridden: boolean;
  evalResult: EvalResult | null;
  parse: ParseResult;
}

export function adjudicate(version: DepVersion, dist: Distribution): Adjudication {
  const parse = parseExpression(version.expression);
  const issues: Issue[] = [];
  for (const pi of parse.issues) {
    issues.push({ kind: pi.code === 'syntax' || pi.code === 'empty' ? 'parse' : 'unknown', message: pi.message, span: pi.span });
  }

  let evalResult: EvalResult | null = null;
  let verdict: Adjudication['verdict'] = 'invalid';
  let obligations: ObligationState[] = [];

  if (parse.ast && parse.issues.length === 0) {
    evalResult = evaluateExpression(parse.ast, dist);
    verdict = evalResult.verdict;

    for (const c of evalResult.conflicts) {
      if (evalResult.verdict !== 'conflict') break; // 备选分支的冲突不阻塞已放行路径
      issues.push({
        kind: 'conflict',
        message: `冲突组合：${c.reason}`,
        span: { start: Math.min(c.spanA.start, c.spanB.start), end: Math.max(c.spanA.end, c.spanB.end) },
      });
    }

    obligations = evalResult.obligations.map((key) => {
      const def = OBLIGATIONS[key];
      const evidence = (version.evidence[key] ?? '').trim();
      return { key, label: def?.label ?? key, desc: def?.desc ?? '', evidence, satisfied: evidence.length > 0 };
    });

    if (evalResult.verdict === 'conditional') {
      for (const o of obligations) {
        if (o.satisfied) continue;
        const leaf = evalResult.perLicense.find((pl) => pl.obligations.includes(o.key));
        issues.push({ kind: 'missing-evidence', message: `附条件义务「${o.label}」缺少证据`, span: leaf?.span, obligationKey: o.key });
      }
    }

    if (evalResult.verdict === 'forbidden') {
      for (const pl of evalResult.perLicense) {
        if (pl.verdict !== 'forbidden') continue;
        issues.push({ kind: 'forbidden', message: `「${pl.id}」在「${DISTRIBUTION_LABEL[dist]}」下被策略禁止`, span: pl.span });
      }
    }
  }

  const overridden = !!version.override && version.override.justification.trim().length > 0;
  let status: DepStatus;
  if (overridden) status = 'allow';
  else if (verdict === 'invalid' || verdict === 'conflict') status = 'review';
  else if (verdict === 'forbidden') status = 'forbidden';
  else if (verdict === 'conditional') status = obligations.every((o) => o.satisfied) ? 'conditional' : 'review';
  else status = 'allow';

  return { status, verdict, issues, obligations, overridden, evalResult, parse };
}

export function adjudicateDependency(dep: Dependency, dist: Distribution): Adjudication {
  return adjudicate(latestVersion(dep), dist);
}

// ---------------------------------------------------------------------------
// 整批汇总：任何未放行项都让整批停在待复核
// ---------------------------------------------------------------------------

export interface BatchSummary {
  total: number;
  allow: number;
  conditional: number;
  forbidden: number;
  review: number;
  overridden: number;
  approved: boolean;
}

export function summarizeBatch(items: Adjudication[]): BatchSummary {
  const s: BatchSummary = { total: items.length, allow: 0, conditional: 0, forbidden: 0, review: 0, overridden: 0, approved: false };
  for (const a of items) {
    s[a.status]++;
    if (a.overridden) s.overridden++;
  }
  s.approved = s.total > 0 && items.every((a) => a.status === 'allow' || a.status === 'conditional');
  return s;
}

// ---------------------------------------------------------------------------
// 报告导出（仅在整批放行后由 UI 调用）
// ---------------------------------------------------------------------------

export function buildMarkdownReport(ws: Workspace, rows: { dep: Dependency; adj: Adjudication }[]): string {
  const lines: string[] = [
    '# License Lens 裁决报告',
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 分发方式：${DISTRIBUTION_LABEL[ws.distribution]}`,
    `- 依赖总数：${rows.length}`,
    `- 人工授权：${rows.filter((r) => r.adj.overridden).length} 条`,
    '',
    '| 依赖 | 版本 | SPDX 表达式 | 裁决 | 依据 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const { dep, adj } of rows) {
    const v = latestVersion(dep);
    const verdict = adj.overridden ? '人工放行' : STATUS_LABEL[adj.status];
    let note = '—';
    if (adj.overridden && v.override) note = `人工授权（${v.override.author || '未署名'}）：${v.override.justification}`;
    else if (adj.obligations.length) note = adj.obligations.map((o) => `${o.label}：${o.evidence || '未提供'}`).join('；');
    else if (adj.issues.length) note = adj.issues.map((i) => i.message).join('；');
    lines.push(`| ${dep.name} | ${dep.spec || '—'} | \`${v.expression}\` | ${verdict} | ${note} |`);
  }
  lines.push('', '## 版本链', '');
  for (const { dep } of rows) {
    lines.push(`### ${dep.name}`);
    for (const v of [...dep.versions].reverse()) {
      const ov = v.override ? ` · 人工授权（${v.override.author || '未署名'}）：${v.override.justification}` : '';
      lines.push(`- v${v.n} · ${fmtTime(v.importedAt)} · \`${v.expression}\` · ${v.reason}${ov}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 示例工作区
// ---------------------------------------------------------------------------

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function seedWorkspace(): Workspace {
  let ws: Workspace = { distribution: 'saas', dependencies: [], updatedAt: new Date().toISOString() };
  const manifest = [
    'react@18.3.1 MIT',
    'lodash@4.17.21 MIT',
    'left-pad@1.3.0 MIT',
    'sharp@0.33.4 Apache-2.0',
    'ffmpeg-static@5.2.0 LGPL-2.1-or-later',
    'legacy-gpl@2.4.0 GPL-3.0-only',
    'saas-core@1.0.0 AGPL-3.0-only',
    'dual-stack@3.1.0 (GPL-2.0-only AND Apache-2.0)',
    'mystery-lib@0.9.0 CDLA-Sharing-1.0',
    'some-proprietary@1.0.0 Proprietary',
    'font-awesome@6.5.2 (OFL-1.1 AND CC-BY-4.0)',
    'zod@3.23.8 MIT AND BSD-3-Clause',
  ].join('\n');
  ws = importEntries(ws, parseManifest(manifest), '初始导入示例清单').ws;
  // 演示版本链：left-pad 表达式变更 → v2
  ws = importEntries(ws, parseManifest('left-pad@1.3.0 (MIT OR Apache-2.0)'), '上游补充双许可证声明').ws;
  // 演示附条件放行：font-awesome 预填署名证据
  const fa = ws.dependencies.find((d) => d.key === 'font-awesome');
  if (fa) ws = setEvidence(ws, fa.key, latestVersion(fa).n, 'attribution', '已在关于页面标注字体作者并链接 CC-BY-4.0 全文');
  return ws;
}
