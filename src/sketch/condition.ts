// Works out the expression after #if / #elif, as C's preprocessor does: numbers, names (their #define's
// value, or 0), defined X / defined(X), brackets and C's operators.
//
// It is a parser on purpose: the desktop app's security policy blocks eval and new Function outside
// the program threads, so building the expression as code made every #if false there (it only
// worked in the dev page, which has no such policy).

const TOKEN = /\s*(0[xX][0-9A-Fa-f]+[uUlL]*|\d+(?:\.\d+)?[uUlL]*|[A-Za-z_]\w*|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%()<>!~&|^?:])/y;

/** how tightly each two-sided operator binds */
const BINDS: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};
const APPLY: Record<string, (a: number, b: number) => number> = {
  '||': (a, b) => Number(!!(a || b)), '&&': (a, b) => Number(!!(a && b)),
  '|': (a, b) => a | b, '^': (a, b) => a ^ b, '&': (a, b) => a & b,
  '==': (a, b) => Number(a === b), '!=': (a, b) => Number(a !== b),
  '<': (a, b) => Number(a < b), '>': (a, b) => Number(a > b), '<=': (a, b) => Number(a <= b), '>=': (a, b) => Number(a >= b),
  '<<': (a, b) => a * 2 ** b, '>>': (a, b) => Math.floor(a / 2 ** b),
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b,
  '/': (a, b) => (b ? Math.trunc(a / b) : 0), '%': (a, b) => (b ? a % b : 0),
};
const MAX_DEPTH = 64;

/** True when the condition holds; false when it doesn't, or can't be read. */
export function conditionTrue(expr: string, defs: Map<string, number>): boolean {
  const text = expr.trim();
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const m = TOKEN.exec(text);
    if (!m) return false;
    tokens.push(m[1]);
  }
  let i = 0;
  let ok = true;
  const take = (want?: string): string => {
    const t = tokens[i];
    if (t === undefined || (want !== undefined && t !== want)) {
      ok = false;
      return '';
    }
    i++;
    return t;
  };

  function value(depth: number): number {
    if (depth > MAX_DEPTH) {
      ok = false;
      return 0;
    }
    const t = take();
    if (!ok) return 0;
    if (t === '(') {
      const v = whole(depth + 1);
      take(')');
      return v;
    }
    if (t === '!') return Number(!value(depth + 1));
    if (t === '~') return ~value(depth + 1);
    if (t === '-') return -value(depth + 1);
    if (t === '+') return value(depth + 1);
    if (t === 'defined') {
      const bracket = tokens[i] === '(';
      if (bracket) take('(');
      const name = take();
      if (bracket) take(')');
      return Number(defs.has(name));
    }
    if (/^[A-Za-z_]/.test(t)) return t === 'true' && !defs.has(t) ? 1 : defs.get(t) ?? 0;
    if (/^\d/.test(t)) return Number(t.replace(/[uUlL]+$/, ''));
    ok = false;
    return 0;
  }

  function binary(min: number, depth: number): number {
    let left = value(depth);
    for (;;) {
      const op = tokens[i];
      const binds = op === undefined ? 0 : BINDS[op] ?? 0;
      if (!ok || !binds || binds < min) return left;
      i++;
      left = APPLY[op](left, binary(binds + 1, depth + 1));
    }
  }

  function whole(depth: number): number {
    const test = binary(1, depth);
    if (tokens[i] !== '?') return test;
    i++;
    const yes = whole(depth + 1);
    take(':');
    const no = whole(depth + 1);
    return test ? yes : no;
  }

  if (!tokens.length) return false;
  const result = whole(0);
  return ok && i === tokens.length && !!result;
}
