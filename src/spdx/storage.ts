// 本地持久化模块（ANCHOR-MODULE: storage）
// 只负责 PersistState 的加载、校验、订阅与落盘；不含策略，也不依赖 React。
// 通过极简 external store（subscribe + getSnapshot）暴露给 React，刷新后数据一致。

import type { Dependency, Distribution, ObligationKey, PersistState, VersionRecord } from './types';
import type { ImportResult } from './importer';

const KEY = 'license-lens:v1';

export const SAMPLE_MANIFEST = [
  'react@18.3.1 MIT',
  'lodash@4.17.21 (MIT AND 0BSD)',
  'sharp@0.33.4 Apache-2.0',
  'jpeg-reader@2.4.0 (GPL-2.0-or-later WITH Classpath-exception-2.0)',
  'atlas-db-connector@3.1.0 (AGPL-3.0-or-later OR SSPL-1.0)',
  'legacy-codec@1.0.9 GPL-3.0-only',
  'vendor-ocr@2.0.1 Proprietary',
  'brand-icons@6.5.2 CC-BY-4.0',
  'mystery-lib@0.4.2 WeDontKnow-1.0',
  'event-bus@1.8.0 (MPL-2.0 OR Apache-2.0)',
].join('\n');

function nowIso(): string {
  return new Date().toISOString();
}

function seedState(): PersistState {
  const lines = SAMPLE_MANIFEST.split('\n');
  // 预置一条已取证的放行样例，直观呈现「放行 / 待复核」并存的批次状态
  const presolved = new Map<string, VersionRecord['evidence']>([
    ['react', { 'state-changes': 'NOTICE.md#L12（已保留版权与许可证声明）' }],
    ['lodash', { 'state-changes': 'NOTICE.md#L18（MIT / 0BSD 声明均已保留）' }],
  ]);
  const deps: Dependency[] = lines.map((line, i) => {
    const m = line.match(/^(.+)@([^\s@]+)\s+(.+)$/)!;
    const record: VersionRecord = {
      revision: 1,
      importedAt: nowIso(),
      version: m[2],
      expression: m[3],
      distribution: 'proprietary-binary',
      evidence: presolved.get(m[1]) ?? {},
    };
    return { id: `dep-${i + 1}`, name: m[1], versions: [record] };
  });
  return { schema: 1, distribution: 'proprietary-binary', dependencies: deps };
}

function validate(raw: unknown): PersistState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<PersistState>;
  if (s.schema !== 1 || !Array.isArray(s.dependencies)) return null;
  if (!s.distribution) return null;
  for (const d of s.dependencies) {
    if (typeof d.id !== 'string' || typeof d.name !== 'string' || !Array.isArray(d.versions) || d.versions.length === 0) {
      return null;
    }
  }
  return s as PersistState;
}

// ---- 单例状态 ----

let state: PersistState = load();
const listeners = new Set<() => void>();

function load(): PersistState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = validate(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* 损坏数据回退到示例 */
  }
  return seedState();
}

function commit(next: PersistState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 配额或隐私模式：会话内仍可用 */
  }
  listeners.forEach((fn) => fn());
}

export const store = {
  getState(): PersistState {
    return state;
  },
  getServerSnapshot(): PersistState {
    return state;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  setDistribution(distribution: Distribution) {
    commit({ ...state, distribution });
  },

  /** 应用导入计划：新版本追加进版本链，新依赖建档 */
  applyImports(plans: ImportResult[]) {
    const deps = [...state.dependencies];
    for (const plan of plans) {
      if (!plan.record) continue;
      const idx = deps.findIndex((d) => d.name === plan.entry.name);
      if (idx === -1) {
        deps.push({ id: `dep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: plan.entry.name, versions: [plan.record] });
      } else {
        deps[idx] = { ...deps[idx], versions: [...deps[idx].versions, plan.record] };
      }
    }
    commit({ ...state, dependencies: deps });
  },

  setEvidence(depId: string, key: ObligationKey, value: string) {
    commit({
      ...state,
      dependencies: state.dependencies.map((d) =>
        d.id !== depId
          ? d
          : {
              ...d,
              versions: d.versions.map((v, i, arr) =>
                i === arr.length - 1 ? { ...v, evidence: { ...v.evidence, [key]: value } } : v,
              ),
            },
      ),
    });
  },

  setOverride(depId: string, authorizedBy: string, basis: string) {
    commit({
      ...state,
      dependencies: state.dependencies.map((d) =>
        d.id !== depId
          ? d
          : {
              ...d,
              versions: d.versions.map((v, i, arr) =>
                i === arr.length - 1
                  ? { ...v, override: authorizedBy.trim() && basis.trim() ? { authorizedBy, basis, at: nowIso() } : undefined }
                  : v,
              ),
            },
      ),
    });
  },

  clearOverride(depId: string) {
    commit({
      ...state,
      dependencies: state.dependencies.map((d) =>
        d.id !== depId
          ? d
          : { ...d, versions: d.versions.map((v, i, arr) => (i === arr.length - 1 ? { ...v, override: undefined } : v)) },
      ),
    });
  },

  removeDependency(depId: string) {
    commit({ ...state, dependencies: state.dependencies.filter((d) => d.id !== depId) });
  },

  resetAll() {
    commit(seedState());
  },
};
