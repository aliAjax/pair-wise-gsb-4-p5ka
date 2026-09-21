// SPDX 策略裁决模块（ANCHOR-MODULE: policy）
// 输入：表达式文本 + 项目分发方式；输出：与语法树同构的裁决树。
// 本模块不知道 React、不做持久化；规则集中在这里，便于法务复核。

import { parseSpdx, spanText } from './parser';
import type {
  DecisionNode,
  Distribution,
  Evaluation,
  LicNode,
  Obligation,
  Status,
} from './types';

// ---------------- 许可证登记表 ----------------

type CopyleftStrength =
  | 'none' // 宽松许可
  | 'weak' // MPL / LGPL 等：文件级或动态链接
  | 'strong' // GPL：整体衍生作品
  | 'network' // AGPL：网络使用也触发
  | 'proprietary' // 专有 / Source Available
  | 'asset'; // 内容类（CC、字体例外）

interface LicenseProfile {
  name: string;
  strength: CopyleftStrength;
}

const LICENSES: Record<string, LicenseProfile> = {
  // 宽松许可
  MIT: { name: 'MIT License', strength: 'none' },
  'MIT-0': { name: 'MIT No Attribution', strength: 'none' },
  'Apache-2.0': { name: 'Apache License 2.0', strength: 'none' },
  'Apache-1.1': { name: 'Apache License 1.1', strength: 'none' },
  'BSD-2-Clause': { name: 'BSD 2-Clause', strength: 'none' },
  'BSD-3-Clause': { name: 'BSD 3-Clause', strength: 'none' },
  'ISC': { name: 'ISC License', strength: 'none' },
  '0BSD': { name: 'BSD Zero Clause', strength: 'none' },
  'Unlicense': { name: 'The Unlicense', strength: 'none' },
  'CC0-1.0': { name: 'Creative Commons Zero', strength: 'none' },
  'Zlib': { name: 'zlib License', strength: 'none' },
  'Python-2.0': { name: 'Python License 2.0', strength: 'none' },
  'PSF-2.0': { name: 'Python Software Foundation License', strength: 'none' },
  // 弱 copyleft
  'MPL-2.0': { name: 'Mozilla Public License 2.0', strength: 'weak' },
  'LGPL-2.1-only': { name: 'LGPL v2.1', strength: 'weak' },
  'LGPL-2.1-or-later': { name: 'LGPL v2.1+', strength: 'weak' },
  'LGPL-3.0-only': { name: 'LGPL v3', strength: 'weak' },
  'LGPL-3.0-or-later': { name: 'LGPL v3+', strength: 'weak' },
  'EPL-2.0': { name: 'Eclipse Public License 2.0', strength: 'weak' },
  'EPL-1.0': { name: 'Eclipse Public License 1.0', strength: 'weak' },
  'CDDL-1.0': { name: 'CDDL 1.0', strength: 'weak' },
  'CPL-1.0': { name: 'Common Public License 1.0', strength: 'weak' },
  // 强 copyleft
  'GPL-2.0-only': { name: 'GNU GPL v2', strength: 'strong' },
  'GPL-2.0-or-later': { name: 'GNU GPL v2+', strength: 'strong' },
  'GPL-3.0-only': { name: 'GNU GPL v3', strength: 'strong' },
  'GPL-3.0-or-later': { name: 'GNU GPL v3+', strength: 'strong' },
  // 网络 copyleft
  'AGPL-3.0-only': { name: 'GNU AGPL v3', strength: 'network' },
  'AGPL-3.0-or-later': { name: 'GNU AGPL v3+', strength: 'network' },
  // 专有 / Source Available（禁止随意再分发）
  'Proprietary': { name: '专有商业许可证', strength: 'proprietary' },
  'BUSL-1.1': { name: 'Business Source License 1.1', strength: 'proprietary' },
  'SSPL-1.0': { name: 'Server Side Public License', strength: 'proprietary' },
  'Elastic-2.0': { name: 'Elastic License 2.0', strength: 'proprietary' },
  // 内容资产类（不能直接当代码许可证）
  'CC-BY-4.0': { name: 'CC BY 4.0', strength: 'asset' },
  'CC-BY-SA-4.0': { name: 'CC BY-SA 4.0', strength: 'asset' },
  'OFL-1.1': { name: 'SIL Open Font License 1.1', strength: 'asset' },
};

// GPL-2.0/3.0 这类无 -only/-or-later 后缀的写法，SPDX 2.x 视为已弃用但仍可解析，
// 这里按对应 *-only 处理。
const DEPRECATED_ALIAS: Record<string, string> = {
  'GPL-2.0': 'GPL-2.0-only',
  'GPL-3.0': 'GPL-3.0-only',
  'LGPL-2.1': 'LGPL-2.1-only',
  'LGPL-3.0': 'LGPL-3.0-only',
  'AGPL-3.0': 'AGPL-3.0-only',
  'Apache': 'Apache-2.0',
};

/** 已登记的 SPDX 例外（WITH 子句）。例外会移除强 copyleft 的特定限制。 */
const EXCEPTIONS = new Set<string>([
  'Classpath-exception-2.0',
  'GCC-exception-3.1',
  'LGPL-3.0-linking-exception',
  'LGPL-2.1-linking-exception',
  'Autoconf-exception-3.0',
  'Bison-exception-2.2',
  'Font-exception-2.0',
  'OCaml-LGPL-linking-exception',
  'WxWindows-exception-3.1',
  'u-boot-exception-2.0',
]);

// ---------------- 义务定义 ----------------

const OBL: Record<string, Obligation> = {
  'state-changes': {
    key: 'state-changes',
    label: '声明修改',
    detail: '分发修改版时必须显著标注对原始文件的改动。',
  },
  'source-available': {
    key: 'source-available',
    label: '提供对应源码',
    detail: '随分发物提供，或以书面报价方式提供对应完整源码。',
  },
  'copyleft-same-license': {
    key: 'copyleft-same-license',
    label: '衍生作品同许可证',
    detail: '包含该组件的整体作品须以同一（或兼容的）copyleft 许可证发布。',
  },
  'network-source': {
    key: 'network-source',
    label: '网络用户可获取源码',
    detail: '即使仅通过网络交互，也要向所有远程用户提供对应源码。',
  },
  'commercial-license': {
    key: 'commercial-license',
    label: '取得商业授权',
    detail: '需要持有厂商书面商业授权或订阅凭证后才能随产品分发。',
  },
  'attribution-assets': {
    key: 'attribution-assets',
    label: '资产署名与用途确认',
    detail: '内容/字体类许可证需要署名并确认其资产用途，不能默认当代码许可证使用。',
  },
};

const STATUS_RANK: Record<Status, number> = {
  allow: 0,
  conditional: 1,
  review: 2,
  deny: 3,
};

function worse(a: Status, b: Status): Status {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

// ---------------- 叶子裁决 ----------------

function evalLicense(
  id: string,
  plus: boolean,
  distribution: Distribution,
): { status: Status; reasons: string[]; obligations: Obligation[]; unknownId?: string } {
  const reasons: string[] = [];
  const obligations: Obligation[] = [];

  // 未登记标识：不猜测，交给人工复核
  const resolved = DEPRECATED_ALIAS[id] ?? id;
  const profile = LICENSES[resolved];
  if (!profile) {
    reasons.push(`SPDX 标识「${id}」未在许可证登记表中，不能自动判断兼容性。`);
    if (plus) reasons.push('该标识带有 or-later(+) 后缀，但标识本身未知。');
    return { status: 'review', reasons, obligations, unknownId: id };
  }

  const suffix = plus ? '（+：or-later 之后续版本）' : '';

  // 内部使用：任何许可证都不触发分发义务
  if (distribution === 'internal') {
    reasons.push(`内部使用且不分发，${profile.name}${suffix}不触发分发义务。`);
    return { status: 'allow', reasons, obligations };
  }

  switch (profile.strength) {
    case 'none': {
      reasons.push(`${profile.name}${suffix}属于宽松许可证，允许闭源与商业使用。`);
      if (distribution !== 'saas') {
        reasons.push('分发副本时需保留版权声明与许可证全文。');
        obligations.push(OBL['state-changes']);
        return { status: 'conditional', reasons, obligations };
      }
      reasons.push('SaaS 不发生副本分发，保留声明的义务按惯例在 NOTICE 中履行即可。');
      return { status: 'allow', reasons, obligations };
    }
    case 'weak': {
      reasons.push(`${profile.name}${suffix}是弱 copyleft，要求受许可文件保持开源，但不强制整体作品开源。`);
      if (distribution === 'proprietary-binary') {
        reasons.push('以动态链接/独立库方式集成并提供对应源码方可随闭源产品分发。');
        obligations.push(OBL['source-available'], OBL['state-changes']);
        return { status: 'conditional', reasons, obligations };
      }
      if (distribution === 'opensource') {
        reasons.push('项目整体开源分发，弱 copyleft 条款可被满足。');
        obligations.push(OBL['state-changes']);
        return { status: 'conditional', reasons, obligations };
      }
      // SaaS：弱 copyleft 不分发即不触发
      reasons.push('SaaS 场景不发生副本分发，弱 copyleft 义务通常不触发。');
      return { status: 'allow', reasons, obligations };
    }
    case 'strong': {
      reasons.push(`${profile.name}${suffix}是强 copyleft，衍生作品整体须按该许可证开源。`);
      if (distribution === 'proprietary-binary') {
        reasons.push('闭源分发与强 copyleft 的整体开源要求冲突。');
        obligations.push(OBL['copyleft-same-license'], OBL['source-available']);
        return { status: 'deny', reasons, obligations };
      }
      if (distribution === 'opensource') {
        reasons.push('项目开源分发且许可证兼容时可以使用。');
        obligations.push(OBL['source-available'], OBL['state-changes']);
        return { status: 'conditional', reasons, obligations };
      }
      // SaaS：GPL 不分发不触发（与 AGPL 的关键区别）
      reasons.push('GPL 的 copyleft 以分发为触发条件，SaaS 不对外分发副本时不触发。');
      return { status: 'allow', reasons, obligations };
    }
    case 'network': {
      reasons.push(`${profile.name}${suffix}是网络 copyleft，远程网络交互即视同分发。`);
      if (distribution === 'saas') {
        reasons.push('SaaS 向远程用户提供服务，必须让所有网络用户可获取对应源码。');
        obligations.push(OBL['network-source'], OBL['source-available']);
        return { status: 'conditional', reasons, obligations };
      }
      if (distribution === 'opensource') {
        reasons.push('项目开源分发且许可证兼容时可以使用。');
        obligations.push(OBL['network-source'], OBL['source-available']);
        return { status: 'conditional', reasons, obligations };
      }
      reasons.push('闭源分发无法满足网络 copyleft 的开源义务。');
      obligations.push(OBL['network-source'], OBL['copyleft-same-license']);
      return { status: 'deny', reasons, obligations };
    }
    case 'proprietary': {
      reasons.push(`${profile.name}${suffix}不允许未经授权再分发或提供竞争性服务。`);
      obligations.push(OBL['commercial-license']);
      reasons.push('须取得厂商书面商业授权后才能用于当前分发方式。');
      return { status: 'deny', reasons, obligations };
    }
    case 'asset': {
      reasons.push(`${profile.name}${suffix}面向内容/字体资产，不应当作普通代码许可证。`);
      obligations.push(OBL['attribution-assets']);
      return { status: 'conditional', reasons, obligations };
    }
  }
}

// ---------------- 树裁决 ----------------

function evaluateNode(node: LicNode, expression: string, distribution: Distribution): DecisionNode {
  if (node.kind === 'lic') {
    const leaf = evalLicense(node.id, node.plus, distribution);
    return {
      span: node.span,
      text: spanText(expression, node.span),
      status: leaf.status,
      reasons: leaf.reasons,
      obligations: leaf.obligations,
      unknownId: leaf.unknownId,
      children: [],
    };
  }

  if (node.kind === 'with') {
    const child = evaluateNode(node.node, expression, distribution);
    const known = EXCEPTIONS.has(node.exception);
    if (!known) {
      return {
        span: node.span,
        text: spanText(expression, node.span),
        status: 'review',
        reasons: [...child.reasons, `例外标识「${node.exception}」未登记，无法确认其豁免范围。`],
        obligations: child.obligations,
        unknownId: node.exception,
        children: [child],
      };
    }
    // 已登记例外：链接/类路径例外可把强 copyleft 降为弱 copyleft 处理
    let status = child.status;
    const reasons = [...child.reasons, `附带已登记例外 ${node.exception}：按其豁免条款放宽链接/组合限制。`];
    let obligations = child.obligations;
    if (/Classpath|linking-exception/.test(node.exception)) {
      if (child.status === 'deny' && distribution === 'proprietary-binary') {
        status = 'conditional';
        obligations = [OBL['source-available']];
        reasons.push('该例外明确允许与闭源作品链接，禁止结论改为附条件：提供库本身源码并遵守例外条款。');
      }
    }
    return {
      span: node.span,
      text: spanText(expression, node.span),
      status,
      reasons,
      obligations,
      children: [child],
    };
  }

  const left = evaluateNode(node.left, expression, distribution);
  const right = evaluateNode(node.right, expression, distribution);

  if (node.kind === 'and') {
    // 冲突检测：copyleft（强/网络）与专有同时出现且当前分发方式无法调和
    const strengths = collectStrengths(node);
    const conflict = detectConflict(strengths, distribution);
    const status: Status = conflict ? 'deny' : worse(left.status, right.status);
    const obligations = dedupeObligations([...left.obligations, ...right.obligations]);
    const reasons = conflict
      ? [`AND 要求同时遵守两侧许可证，存在冲突：${conflict}`]
      : [`AND 要求同时满足两侧义务（${left.text} 与 ${right.text}）。`];
    if (!conflict) {
      if (left.status !== 'allow' || right.status !== 'allow') {
        reasons.push('两侧义务必须全部履行后，该组合才可放行。');
      }
    }
    return {
      span: node.span,
      text: spanText(expression, node.span),
      status,
      reasons,
      obligations,
      conflict,
      children: [left, right],
    };
  }

  // OR：选择一条最宽松且可成立的路径；被选路径仍需满足自身义务
  const ordered = STATUS_RANK[left.status] <= STATUS_RANK[right.status]
    ? { better: left, other: right }
    : { better: right, other: left };
  ordered.better.chosen = true;
  const reasons = [
    `OR 提供二选一的合规路径，已按当前分发方式选定「${ordered.better.text}」。`,
    `未选路径「${ordered.other.text}」状态为${statusCn(ordered.other.status)}，不影响本表达式结论。`,
  ];
  // 若两条路径都被禁止，则 OR 也被禁止
  return {
    span: node.span,
    text: spanText(expression, node.span),
    status: ordered.better.status === 'deny' && ordered.other.status === 'deny' ? 'deny' : ordered.better.status,
    reasons,
    obligations: ordered.better.obligations,
    children: [left, right],
  };
}

function statusCn(s: Status): string {
  return { allow: '允许', conditional: '附条件', deny: '禁止', review: '待复核' }[s];
}

function collectStrengths(node: LicNode): CopyleftStrength[] {
  if (node.kind === 'lic') {
    const profile = LICENSES[DEPRECATED_ALIAS[node.id] ?? node.id];
    return profile ? [profile.strength] : [];
  }
  if (node.kind === 'with') return collectStrengths(node.node);
  return [...collectStrengths(node.left), ...collectStrengths(node.right)];
}

function detectConflict(strengths: CopyleftStrength[], distribution: Distribution): string | undefined {
  const hasProprietary = strengths.includes('proprietary');
  const hasStrong = strengths.includes('strong');
  const hasNetwork = strengths.includes('network');
  if (distribution === 'proprietary-binary' && hasProprietary && (hasStrong || hasNetwork)) {
    return '专有商业组件与强/网络 copyleft 组件要求同时遵守时，闭源分发无法同时满足双方条款。';
  }
  if (distribution === 'opensource' && hasProprietary && (hasStrong || hasNetwork)) {
    return '专有组件禁止再分发，与开源/copyleft 组件要求整体公开的条款互斥。';
  }
  if (distribution === 'saas' && hasProprietary && hasNetwork) {
    return '网络 copyleft 要求向用户公开源码，专有组件禁止公开，SaaS 场景下两者无法同时满足。';
  }
  return undefined;
}

function dedupeObligations(list: Obligation[]): Obligation[] {
  const seen = new Set<string>();
  return list.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
}

// ---------------- 公开入口 ----------------

/** 解析 + 裁决：策略模块的唯一公开入口 */
export function evaluateExpression(expression: string, distribution: Distribution): Evaluation {
  const { tree, issues } = parseSpdx(expression);
  if (!tree) return { root: null, parseErrors: issues };
  return { root: evaluateNode(tree, expression, distribution), parseErrors: issues };
}
