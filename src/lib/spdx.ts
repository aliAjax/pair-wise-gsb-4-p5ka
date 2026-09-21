// SPDX 表达式解析模块
// 职责：词法分析 → 递归下降解析（WITH > AND > OR）→ 标识符校验。
// 所有问题都带 span（起止偏移），供 UI 定位到具体子表达式。
// 本模块不做任何策略判断，也不触碰持久化。

export interface Span {
  start: number;
  end: number;
}

export type ExprNode =
  | {
      kind: 'license';
      id: string;
      exception: string | null;
      plus: boolean;
      idSpan: Span;
      exceptionSpan: Span | null;
      span: Span;
    }
  | { kind: 'and' | 'or'; left: ExprNode; right: ExprNode; span: Span };

export type LicenseLeaf = Extract<ExprNode, { kind: 'license' }>;

export type IssueCode = 'empty' | 'syntax' | 'unknown-license' | 'unknown-exception';

export interface ParseIssue {
  code: IssueCode;
  message: string;
  span: Span;
}

export interface ParseResult {
  ast: ExprNode | null;
  issues: ParseIssue[];
}

// ---------------------------------------------------------------------------
// 已知许可证 / 异常表（SPDX License List 的常用子集 + Proprietary 占位）
// cls 是策略模块使用的许可证类别；family 用于冲突判定。
// ---------------------------------------------------------------------------

export type LicenseClass =
  | 'permissive'
  | 'public-domain'
  | 'weak'
  | 'strong'
  | 'network'
  | 'proprietary'
  | 'other';

export interface LicenseMeta {
  id: string;
  name: string;
  cls: LicenseClass;
  family: string;
  note?: string;
}

const L = (id: string, name: string, cls: LicenseClass, family: string, note?: string): LicenseMeta => ({
  id,
  name,
  cls,
  family,
  note,
});

export const KNOWN_LICENSES: Record<string, LicenseMeta> = Object.fromEntries(
  [
    L('MIT', 'MIT License', 'permissive', 'MIT'),
    L('MIT-0', 'MIT No Attribution', 'permissive', 'MIT'),
    L('ISC', 'ISC License', 'permissive', 'ISC'),
    L('BSD-2-Clause', 'BSD 2-Clause “Simplified”', 'permissive', 'BSD'),
    L('BSD-3-Clause', 'BSD 3-Clause “New”', 'permissive', 'BSD'),
    L('Apache-2.0', 'Apache License 2.0', 'permissive', 'Apache', '含专利授权与修改标注义务'),
    L('Zlib', 'zlib License', 'permissive', 'Zlib'),
    L('BSL-1.0', 'Boost Software License 1.0', 'permissive', 'BSL'),
    L('PostgreSQL', 'PostgreSQL License', 'permissive', 'PostgreSQL'),
    L('Python-2.0', 'Python License 2.0', 'permissive', 'Python'),
    L('WTFPL', 'WTFPL', 'permissive', 'WTFPL'),
    L('MS-PL', 'Microsoft Public License', 'permissive', 'MS-PL', '与 GPL 系列不兼容'),
    L('Artistic-2.0', 'Artistic License 2.0', 'permissive', 'Artistic'),
    L('OFL-1.1', 'SIL Open Font License 1.1', 'permissive', 'OFL', '字体不得单独出售'),
    L('CC0-1.0', 'CC0 1.0 Universal', 'public-domain', 'CC'),
    L('Unlicense', 'The Unlicense', 'public-domain', 'Unlicense'),
    L('MPL-2.0', 'Mozilla Public License 2.0', 'weak', 'MPL'),
    L('EPL-1.0', 'Eclipse Public License 1.0', 'weak', 'EPL'),
    L('EPL-2.0', 'Eclipse Public License 2.0', 'weak', 'EPL'),
    L('CDDL-1.0', 'CDDL 1.0', 'weak', 'CDDL'),
    L('LGPL-2.1-only', 'LGPL 2.1 only', 'weak', 'LGPL'),
    L('LGPL-2.1-or-later', 'LGPL 2.1 or later', 'weak', 'LGPL'),
    L('LGPL-3.0-only', 'LGPL 3.0 only', 'weak', 'LGPL'),
    L('LGPL-3.0-or-later', 'LGPL 3.0 or later', 'weak', 'LGPL'),
    L('GPL-2.0-only', 'GPL 2.0 only', 'strong', 'GPL'),
    L('GPL-2.0-or-later', 'GPL 2.0 or later', 'strong', 'GPL'),
    L('GPL-3.0-only', 'GPL 3.0 only', 'strong', 'GPL'),
    L('GPL-3.0-or-later', 'GPL 3.0 or later', 'strong', 'GPL'),
    L('AGPL-3.0-only', 'AGPL 3.0 only', 'network', 'AGPL'),
    L('AGPL-3.0-or-later', 'AGPL 3.0 or later', 'network', 'AGPL'),
    L('EUPL-1.2', 'European Union Public License 1.2', 'strong', 'EUPL', 'copyleft 覆盖网络服务'),
    L('CC-BY-4.0', 'CC Attribution 4.0', 'other', 'CC'),
    L('CC-BY-SA-4.0', 'CC Attribution-ShareAlike 4.0', 'other', 'CC-SA'),
    L('CC-BY-NC-4.0', 'CC Attribution-NonCommercial 4.0', 'other', 'CC-NC', '禁止商业用途'),
    L('Proprietary', '专有 / 商业许可证', 'proprietary', 'Proprietary', '非 SPDX 标准标识，作为专有软件占位'),
  ].map((m) => [m.id, m]),
);

export const KNOWN_EXCEPTIONS: Record<string, string> = {
  'Classpath-exception-2.0': 'GNU Classpath Exception 2.0',
  'Bison-exception-2.2': 'Bison exception 2.2',
  'Font-exception-2.0': 'Font exception 2.0',
  'LLVM-exception': 'LLVM Exception',
  'OpenSSL-exception': 'OpenSSL Exception',
  'Qt-GPL-exception-1.0': 'Qt GPL exception 1.0',
  'Autoconf-exception-3.0': 'Autoconf exception 3.0',
};

// ---------------------------------------------------------------------------
// 词法分析
// ---------------------------------------------------------------------------

type TokenType = 'id' | 'and' | 'or' | 'with' | 'lparen' | 'rparen' | 'plus';

interface Token {
  type: TokenType;
  text: string;
  span: Span;
}

function tokenize(input: string, issues: ParseIssue[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', text: '(', span: { start: i, end: i + 1 } });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', text: ')', span: { start: i, end: i + 1 } });
      i++;
      continue;
    }
    if (ch === '+') {
      tokens.push({ type: 'plus', text: '+', span: { start: i, end: i + 1 } });
      i++;
      continue;
    }
    const m = /^[A-Za-z0-9][A-Za-z0-9.:\-_]*/.exec(input.slice(i));
    if (m) {
      const text = m[0];
      const upper = text.toUpperCase();
      const type: TokenType = upper === 'AND' ? 'and' : upper === 'OR' ? 'or' : upper === 'WITH' ? 'with' : 'id';
      tokens.push({ type, text, span: { start: i, end: i + text.length } });
      i += text.length;
      continue;
    }
    issues.push({ code: 'syntax', message: `无法识别的字符「${ch}」`, span: { start: i, end: i + 1 } });
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 语法分析（递归下降）：OR < AND < WITH，括号优先
// ---------------------------------------------------------------------------

export function parseExpression(raw: string): ParseResult {
  const issues: ParseIssue[] = [];
  if (!raw.trim()) {
    return { ast: null, issues: [{ code: 'empty', message: '缺少 SPDX 许可证表达式', span: { start: 0, end: 0 } }] };
  }
  const tokens = tokenize(raw, issues);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const syntax = (message: string, span: Span) => {
    issues.push({ code: 'syntax', message, span });
  };

  function parsePrimary(): ExprNode | null {
    const t = peek();
    if (!t) return null;
    if (t.type === 'id') {
      pos++;
      let end = t.span.end;
      let plus = false;
      const nx = peek();
      if (nx && nx.type === 'plus') {
        plus = true;
        end = nx.span.end;
        pos++;
      }
      return {
        kind: 'license',
        id: t.text,
        exception: null,
        plus,
        idSpan: t.span,
        exceptionSpan: null,
        span: { start: t.span.start, end },
      };
    }
    if (t.type === 'lparen') {
      pos++;
      const inner = parseOr();
      const closing = peek();
      if (closing && closing.type === 'rparen') {
        pos++;
        if (inner) inner.span = { start: t.span.start, end: closing.span.end };
        return inner;
      }
      syntax('缺少右括号「)」', t.span);
      return inner;
    }
    syntax(`意外的「${t.text}」`, t.span);
    pos++;
    return null;
  }

  function parseWith(): ExprNode | null {
    const base = parsePrimary();
    if (!base) return null;
    const t = peek();
    if (t && t.type === 'with') {
      pos++;
      const exc = peek();
      if (exc && exc.type === 'id') {
        pos++;
        if (base.kind === 'license') {
          base.exception = exc.text;
          base.exceptionSpan = exc.span;
          base.span = { start: base.span.start, end: exc.span.end };
        } else {
          syntax('WITH 只能跟在许可证标识之后', t.span);
        }
      } else {
        syntax('WITH 后缺少许可证异常标识', t.span);
      }
    }
    return base;
  }

  function parseAnd(): ExprNode | null {
    let left = parseWith();
    while (left) {
      const t = peek();
      if (!t || t.type !== 'and') break;
      pos++;
      const right = parseWith();
      if (!right) {
        syntax('AND 右侧缺少表达式', t.span);
        break;
      }
      left = { kind: 'and', left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  function parseOr(): ExprNode | null {
    let left = parseAnd();
    while (left) {
      const t = peek();
      if (!t || t.type !== 'or') break;
      pos++;
      const right = parseAnd();
      if (!right) {
        syntax('OR 右侧缺少表达式', t.span);
        break;
      }
      left = { kind: 'or', left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  const ast = parseOr();
  const rest = peek();
  if (ast && rest) syntax(`表达式存在无法解析的剩余内容「${rest.text}」`, rest.span);
  if (ast) validateIdentifiers(ast, issues);
  return { ast, issues };
}

// ---------------------------------------------------------------------------
// 标识符校验：未知许可证 / 未知异常 / LicenseRef / NONE / NOASSERTION
// ---------------------------------------------------------------------------

function validateIdentifiers(node: ExprNode, issues: ParseIssue[]): void {
  if (node.kind === 'license') {
    const id = node.id;
    if (id === 'NONE' || id === 'NOASSERTION') {
      issues.push({
        code: 'unknown-license',
        message: id === 'NONE' ? 'NONE 表示无许可证，无法放行' : 'NOASSERTION 表示未声明许可证，需要人工确认',
        span: node.idSpan,
      });
    } else if (/^(DocumentRef-[\w.-]+:)?LicenseRef-/.test(id)) {
      issues.push({ code: 'unknown-license', message: `自定义引用「${id}」不在 SPDX 列表内，需要人工确认`, span: node.idSpan });
    } else if (!KNOWN_LICENSES[id]) {
      issues.push({ code: 'unknown-license', message: `未知许可证标识「${id}」`, span: node.idSpan });
    }
    if (node.exception && !KNOWN_EXCEPTIONS[node.exception]) {
      issues.push({
        code: 'unknown-exception',
        message: `未知许可证异常「${node.exception}」`,
        span: node.exceptionSpan ?? node.span,
      });
    }
    return;
  }
  validateIdentifiers(node.left, issues);
  validateIdentifiers(node.right, issues);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function collectLicenses(node: ExprNode): LicenseLeaf[] {
  return node.kind === 'license' ? [node] : [...collectLicenses(node.left), ...collectLicenses(node.right)];
}

export function sliceSpan(text: string, span: Span): string {
  return text.slice(span.start, span.end);
}
