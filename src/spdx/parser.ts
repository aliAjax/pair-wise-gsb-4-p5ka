// SPDX 表达式解析（ANCHOR-MODULE: parser）
// 依据 SPDX v2.3 附录四语法，手工递归下降实现，不引入任何依赖：
//   expr   := term (OR term)*            （OR 优先级最低）
//   term   := factor ((AND factor)*)
//   factor := LPAREN expr RPAREN | license ('WITH' exception)?
// 语法错误不抛异常，而是收集进 ParseIssue，调用方据其决定「整批待复核」。

import type { LicNode, ParseIssue, Span } from './types';

const KEYWORDS = new Set(['AND', 'OR', 'WITH']);

interface Token {
  text: string;
  start: number;
  end: number;
}

function lex(input: string): { tokens: Token[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const tokens: Token[] = [];
  // 括号与关键字优先，其余整体作为许可证标识候选（可含连字符、点、+）
  const re = /(\(|\))|(\b(?:AND|OR|WITH)\b)|([^\s()]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const start = m.index;
    const end = start + m[0].length;
    const upper = m[0].toUpperCase();
    if (m[1] || KEYWORDS.has(upper)) {
      tokens.push({ text: m[1] ? m[1] : upper, start, end });
    } else if (/^[A-Za-z0-9][A-Za-z0-9.\-]*\+?$/.test(m[0])) {
      tokens.push({ text: m[0], start, end });
    } else {
      issues.push({ message: `无法识别的词法片段「${m[0]}」`, span: { start, end } });
    }
  }
  return { tokens, issues };
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private issues: ParseIssue[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private expectPunct(punct: string): boolean {
    const t = this.peek();
    if (t && t.text === punct) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): LicNode | null {
    if (this.tokens.length === 0) {
      this.issues.push({ message: '许可证表达式为空' });
      return null;
    }
    const node = this.parseOr();
    const extra = this.peek();
    if (extra) {
      this.issues.push({ message: `多余的符号「${extra.text}」`, span: { start: extra.start, end: extra.end } });
    }
    return node;
  }

  // OR 左结合
  private parseOr(): LicNode | null {
    let left = this.parseAnd();
    for (;;) {
      const op = this.peek();
      if (!op || op.text !== 'OR') break;
      this.next();
      const right = this.parseAnd();
      if (!right) {
        this.issues.push({ message: 'OR 之后缺少许可证标识', span: { start: op.start, end: op.end } });
        break;
      }
      left = { kind: 'or', left: left!, right, span: { start: left!.span.start, end: right.span.end } };
    }
    return left;
  }

  // AND 左结合
  private parseAnd(): LicNode | null {
    let left = this.parseFactor();
    for (;;) {
      const op = this.peek();
      if (!op || op.text !== 'AND') break;
      this.next();
      const right = this.parseFactor();
      if (!right) {
        this.issues.push({ message: 'AND 之后缺少许可证标识', span: { start: op.start, end: op.end } });
        break;
      }
      left = { kind: 'and', left: left!, right, span: { start: left!.span.start, end: right.span.end } };
    }
    return left;
  }

  private parseFactor(): LicNode | null {
    const t = this.next();
    if (!t) {
      this.issues.push({ message: '表达式不完整，缺少许可证标识' });
      return null;
    }
    if (t.text === '(') {
      const inner = this.parseOr();
      if (!this.expectPunct(')')) {
        this.issues.push({ message: '缺少右括号 )', span: { start: t.start, end: t.end } });
        return inner;
      }
      const close = this.tokens[this.pos - 1];
      return inner ? { ...inner, span: { start: t.start, end: close.end } } : null;
    }
    if (t.text === ')' || t.text === 'AND' || t.text === 'OR' || t.text === 'WITH') {
      this.issues.push({ message: `意外的关键字「${t.text}」`, span: { start: t.start, end: t.end } });
      return null;
    }
    let plus = false;
    let id = t.text;
    if (id.endsWith('+')) {
      plus = true;
      id = id.slice(0, -1);
    }
    let node: LicNode = { kind: 'lic', id, plus, span: { start: t.start, end: t.end } };
    if (this.peek()?.text === 'WITH') {
      const withTok = this.next()!;
      const exTok = this.next();
      if (!exTok || exTok.text === ')' || ['AND', 'OR', 'WITH'].includes(exTok.text)) {
        this.issues.push({ message: 'WITH 之后缺少例外标识', span: { start: withTok.start, end: withTok.end } });
        return node;
      }
      node = {
        kind: 'with',
        node,
        exception: exTok.text,
        span: { start: t.start, end: exTok.end },
      };
    }
    return node;
  }
}

export interface ParseResult {
  tree: LicNode | null;
  issues: ParseIssue[];
}

/** 只负责语法结构，不判断任何许可证语义 */
export function parseSpdx(expression: string): ParseResult {
  const { tokens, issues } = lex(expression);
  const tree = new Parser(tokens, issues).parse();
  return { tree, issues };
}

export function spanText(expression: string, span: Span): string {
  return expression.slice(span.start, span.end).trim();
}
