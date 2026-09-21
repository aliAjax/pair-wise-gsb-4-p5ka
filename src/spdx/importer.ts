// 依赖清单导入模块（ANCHOR-MODULE: importer）
// 纯文本解析 + 与历史版本比对：只产出「导入意图」，不触碰持久化与策略。

import type { Dependency, Distribution, VersionRecord } from './types';

export interface ManifestEntry {
  name: string;
  version: string;
  expression: string;
  /** 源文件中的行号，便于回报定位 */
  line: number;
}

export type ImportOutcomeKind = 'created' | 'new-revision' | 'unchanged';

export interface ImportResult {
  outcome: ImportOutcomeKind;
  entry: ManifestEntry;
  /** outcome 为 new-revision 时生成的版本记录；created 时为首版 */
  record?: VersionRecord;
  /** unchanged / new-revision 的原因说明 */
  reason: string;
  /** unchanged 时指向已有依赖 */
  dependency?: Dependency;
}

/**
 * 支持两种清单形态：
 *  1) 每行一条：名称@版本  SPDX表达式[, 备注…]
 *  2) package.json 的 dependencies/devDependencies（值即版本范围时，许可证表达式留空待复核）
 */
export function parseManifest(text: string): ManifestEntry[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const entries = tryParsePackageJson(trimmed);
    if (entries) return entries;
  }
  return trimmed
    .split(/\r?\n|,(?=\s*[@\w])/)
    .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
    .filter(({ raw }) => raw && !raw.startsWith('#') && !raw.startsWith('//'))
    .map(({ raw, line }) => {
      // 贪婪匹配最后一个 @，兼容 @scope/name@version
      const m = raw.match(/^(.+)@([^\s@]+)\s+(.+)$/);
      if (m) {
        return { name: m[1].trim(), version: m[2].trim(), expression: m[3].trim(), line };
      }
      const noLic = raw.match(/^(.+)@([^\s@]+)\s*$/);
      if (noLic) {
        return { name: noLic[1].trim(), version: noLic[2].trim(), expression: '', line };
      }
      // 连版本都没有：整行进 name，交给后续流程暴露为缺表达式
      return { name: raw, version: '—', expression: '', line };
    });
}

function tryParsePackageJson(text: string): ManifestEntry[] | null {
  try {
    const json = JSON.parse(text);
    const blocks = [json.dependencies, json.devDependencies, json.optionalDependencies].filter(Boolean);
    const out: ManifestEntry[] = [];
    blocks.forEach((block) => {
      for (const [name, range] of Object.entries(block as Record<string, string>)) {
        out.push({ name, version: String(range), expression: '', line: 0 });
      }
    });
    return out;
  } catch {
    return null;
  }
}

/**
 * 与既有依赖版本链比对，生成导入结果。
 * 已裁决依赖再次导入：表达式或版本变化才生成带原因的新版本；完全一致则不动版本链。
 */
export function planImport(
  entries: ManifestEntry[],
  existing: Dependency[],
  distribution: Distribution,
  now: string,
): ImportResult[] {
  return entries.map((entry) => {
    const dep = existing.find((d) => d.name === entry.name);
    if (!dep) {
      const record: VersionRecord = {
        revision: 1,
        importedAt: now,
        version: entry.version,
        expression: entry.expression,
        distribution,
        evidence: {},
      };
      return { outcome: 'created', entry, record, reason: '首次导入，生成第 1 版。' };
    }
    const latest = dep.versions[dep.versions.length - 1];
    const versionChanged = latest.version !== entry.version;
    const expressionChanged = latest.expression !== entry.expression;
    if (!versionChanged && !expressionChanged) {
      return {
        outcome: 'unchanged',
        entry,
        dependency: dep,
        reason: `名称、版本（${entry.version}）与 SPDX 表达式均与第 ${latest.revision} 版一致，未生成新版本。`,
      };
    }
    const changes: string[] = [];
    if (versionChanged) changes.push(`版本 ${latest.version} → ${entry.version}`);
    if (expressionChanged) changes.push(`SPDX 表达式 ${latest.expression || '（空）'} → ${entry.expression || '（空）'}`);
    const record: VersionRecord = {
      revision: latest.revision + 1,
      importedAt: now,
      version: entry.version,
      expression: entry.expression,
      distribution,
      changeReason: `再次导入：${changes.join('；')}。`,
      evidence: {},
    };
    return {
      outcome: 'new-revision',
      entry,
      record,
      dependency: dep,
      reason: `${record.changeReason} 上一版的证据与授权不自动继承，需要重新裁决。`,
    };
  });
}
