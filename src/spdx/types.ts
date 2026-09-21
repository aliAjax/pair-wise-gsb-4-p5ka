// License Lens 领域模型：SPDX 解析、策略裁决、持久化共用的类型与常量

export type Distribution = 'proprietary-binary' | 'opensource' | 'saas' | 'internal';

export const DISTRIBUTIONS: { id: Distribution; label: string; hint: string }[] = [
  { id: 'proprietary-binary', label: '闭源分发', hint: '随产品发布二进制或源码包，项目本身闭源' },
  { id: 'opensource', label: '开源分发', hint: '项目本身以开源许可证公开发布' },
  { id: 'saas', label: '云端 SaaS', hint: '仅通过网络提供服务，不分发副本' },
  { id: 'internal', label: '内部使用', hint: '不对外分发，也不对外提供网络服务' },
];

export const DISTRIBUTION_LABEL: Record<Distribution, string> = {
  'proprietary-binary': '闭源分发',
  opensource: '开源分发',
  saas: '云端 SaaS',
  internal: '内部使用',
};

// ---- SPDX 表达式语法树（解析模块产出，不含任何策略） ----

export interface Span {
  start: number;
  end: number;
}

export type LicNode =
  | { kind: 'lic'; id: string; plus: boolean; span: Span }
  | { kind: 'with'; node: LicNode; exception: string; span: Span }
  | { kind: 'and' | 'or'; left: LicNode; right: LicNode; span: Span };

export interface ParseIssue {
  message: string;
  span?: Span;
}

// ---- 策略裁决 ----

export type Status = 'allow' | 'conditional' | 'deny' | 'review';

export const STATUS_LABEL: Record<Status, string> = {
  allow: '允许',
  conditional: '附条件',
  deny: '禁止',
  review: '待复核',
};

export type ObligationKey =
  | 'state-changes'
  | 'source-available'
  | 'copyleft-same-license'
  | 'network-source'
  | 'commercial-license'
  | 'attribution-assets';

export interface Obligation {
  key: ObligationKey;
  label: string;
  detail: string;
}

/** 与语法树同构的裁决树，span 用于定位子表达式 */
export interface DecisionNode {
  span: Span;
  text: string;
  status: Status;
  reasons: string[];
  obligations: Obligation[];
  /** 叶子或 WITH 上出现未登记标识时填写 */
  unknownId?: string;
    /** AND 组合存在许可证冲突时填写 */
  conflict?: string;
  /** OR 组合中被选中为合规路径的分支 */
  chosen?: boolean;
  children: DecisionNode[];
}

export interface Evaluation {
  root: DecisionNode | null;
  parseErrors: ParseIssue[];
}

// ---- 批次裁决（结合版本记录上的证据 / 人工授权） ----

export type BlockerKind = 'parse' | 'unknown' | 'conflict' | 'deny' | 'evidence';

export interface Blocker {
  kind: BlockerKind;
  depId: string;
  depName: string;
  revision: number;
  span?: Span;
  /** 命中的子表达式原文 */
  subText?: string;
  message: string;
  obligationKey?: ObligationKey;
}

// ---- 持久化模型 ----

export interface Override {
  authorizedBy: string;
  basis: string;
  at: string;
}

export interface VersionRecord {
  revision: number;
  importedAt: string;
  version: string;
  expression: string;
  /** 导入该版本时项目选择的分发方式（版本链快照用） */
  distribution: Distribution;
  /** 再次导入产生新版本时的原因 */
  changeReason?: string;
  /** 义务证据：凭证路径 / URL / 工单号 */
  evidence: Partial<Record<ObligationKey, string>>;
  /** 人工授权覆盖 */
  override?: Override;
}

export interface Dependency {
  id: string;
  name: string;
  versions: VersionRecord[];
}

export interface PersistState {
  schema: 1;
  distribution: Distribution;
  dependencies: Dependency[];
}
