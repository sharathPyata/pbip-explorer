// Classifies simple measures without the AI, by the same rules INSTRUCTIONS.md gives it: a main field
// is a column whose values make up the result, a helper is one the measure filters or decides by.
// Only shapes whose reading is certain are handled —
//   SUM(T[C]) and the other one-column aggregations · COUNTROWS(T) · a number or text constant
//   SELECTEDVALUE(T[C]) · FORMAT(value, format) — a measure giving the format is a condition
//   arithmetic, text joined with &, DIVIDE, COALESCE, ROUND and the like over those and other measures
//   CALCULATE(value, filters…) and TOTALYTD / TOTALQTD / TOTALMTD(value, 'Date'[Date])
//   where each filter is T[C] compared with a constant, T[C] IN {constants}, && / || of those,
//   KEEPFILTERS(…), ALL / ALLSELECTED / ALLNOBLANKROW / REMOVEFILTERS / ALLEXCEPT, USERELATIONSHIP /
//   CROSSFILTER, or a time-intelligence table function of a date column (SAMEPERIODLASTYEAR, DATESYTD,
//   DATEADD, PARALLELPERIOD, PREVIOUSYEAR, …)
//   IF / SWITCH whose tests are measures compared with constants (conditions) or ISFILTERED /
//   ISINSCOPE / HASONEVALUE / SELECTEDVALUE / VALUES(T[C]) (helpers, "selection"), and whose branches are values
//   VAR … RETURN, each variable classified where it's used · a DAX function that reads nothing from
//   the model, called with constants (FHSQLMonitor's colours).
// Anything else — FILTER, an iterator, an aggregate or a column in a test, a measure in a filter, a
// variable inside CALCULATE's value — returns null, and the measure goes to the AI.
'use strict';

const AGGREGATIONS = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTBLANK', 'DISTINCTCOUNT',
  'DISTINCTCOUNTNOBLANK', 'MEDIAN', 'PRODUCT']);
const REMOVES = new Set(['ALL', 'ALLSELECTED', 'ALLNOBLANKROW', 'REMOVEFILTERS']);
const TIME_TABLES = new Set(['SAMEPERIODLASTYEAR', 'DATESYTD', 'DATESQTD', 'DATESMTD', 'DATEADD', 'PARALLELPERIOD',
  'PREVIOUSYEAR', 'PREVIOUSQUARTER', 'PREVIOUSMONTH', 'PREVIOUSDAY', 'NEXTYEAR', 'NEXTQUARTER', 'NEXTMONTH', 'NEXTDAY']);
const TIME_TOTALS = new Set(['TOTALYTD', 'TOTALQTD', 'TOTALMTD']);
const UNITS = new Set(['YEAR', 'QUARTER', 'MONTH', 'DAY']);
const CONSTANT_CALLS = new Set(['TRUE', 'FALSE', 'BLANK']);

/* DAX → tokens; null if there's something this reader doesn't know. */
function tokenize(dax) {
  const s = String(dax || ''), out = [];
  const readBracket = (i, close) => {        // from s[i] (the opening char) to its close; ]] or '' escapes
    let v = '', j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === close) { if (s[j + 1] === close) { v += close; j++; continue; } return { v, end: j + 1 }; }
      v += s[j];
    }
    return null;
  };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (s.startsWith('//', i) || s.startsWith('--', i)) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (s.startsWith('/*', i)) { const e = s.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (c === '"') { const r = readBracket(i, '"'); if (!r) return null; out.push({ t: 'str', v: r.v }); i = r.end; continue; }
    if (c === "'" || /[\p{L}_]/u.test(c)) {
      let name, end;
      if (c === "'") { const r = readBracket(i, "'"); if (!r) return null; name = r.v; end = r.end; }
      else { const m = s.slice(i).match(/^[\p{L}_][\p{L}\p{N}_.]*/u); name = m[0]; end = i + name.length; }
      if (s[end] === '[') {
        const r = readBracket(end, ']'); if (!r) return null;
        out.push({ t: 'col', table: name, col: r.v }); i = r.end; continue;
      }
      out.push(c === "'" ? { t: 'table', v: name } : { t: 'id', v: name }); i = end; continue;
    }
    if (c === '[') { const r = readBracket(i, ']'); if (!r) return null; out.push({ t: 'ref', v: r.v }); i = r.end; continue; }
    const num = s.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '<>', '==', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('(),{}+-*/=<>&'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    return null;   // ^, @ and anything else: not a shape handled here
  }
  return out;
}

/* Tokens → a small tree, or null. */
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p], take = () => tokens[p++];
  const isOp = (v, tok = peek()) => tok && tok.t === 'op' && tok.v === v;
  const isId = (v, tok = peek()) => tok && tok.t === 'id' && tok.v.toUpperCase() === v;
  function logic() {
    let left = compare(); if (!left) return null;
    while (isOp('&&') || isOp('||')) { const op = take().v; const right = compare(); if (!right) return null; left = { k: 'logic', op, left, right }; }
    return left;
  }
  function compare() {
    const left = concat(); if (!left) return null;
    if (['=', '==', '<>', '<', '>', '<=', '>='].some(o => isOp(o))) { const op = take().v; const right = concat(); return right && { k: 'cmp', op, left, right }; }
    if (isId('IN')) {
      take(); if (!isOp('{')) return null; take();
      const items = [];
      while (!isOp('}')) { const it = concat(); if (!it) return null; items.push(it); if (isOp(',')) take(); else if (!isOp('}')) return null; }
      take();
      return { k: 'in', left, items };
    }
    return left;
  }
  // Text joined with & — below arithmetic, above comparison, as in DAX.
  function concat() {
    let left = additive(); if (!left) return null;
    while (isOp('&')) { take(); const right = additive(); if (!right) return null; left = { k: 'arith', op: '&', left, right }; }
    return left;
  }
  function additive() {
    let left = multiplicative(); if (!left) return null;
    while (isOp('+') || isOp('-')) { const op = take().v; const right = multiplicative(); if (!right) return null; left = { k: 'arith', op, left, right }; }
    return left;
  }
  function multiplicative() {
    let left = unary(); if (!left) return null;
    while (isOp('*') || isOp('/')) { const op = take().v; const right = unary(); if (!right) return null; left = { k: 'arith', op, left, right }; }
    return left;
  }
  function unary() {
    if (isOp('-') || isOp('+')) { take(); const x = unary(); return x && { k: 'neg', x }; }
    return primary();
  }
  function primary() {
    const tok = take();
    if (!tok) return null;
    // VAR name = expr … RETURN expr
    if (isId('VAR', tok)) {
      const defs = [];
      for (;;) {
        const name = take();
        if (!name || name.t !== 'id' || !isOp('=')) return null;
        take();
        const e = logic(); if (!e) return null;
        defs.push([name.v, e]);
        if (isId('VAR')) { take(); continue; }
        if (isId('RETURN')) { take(); break; }
        return null;
      }
      const body = logic();
      return body && { k: 'var', defs, body };
    }
    if (tok.t === 'num' || tok.t === 'str') return { k: 'const' };
    if (tok.t === 'col') return { k: 'col', table: tok.table, col: tok.col };
    if (tok.t === 'ref') return { k: 'ref', name: tok.v };
    if (tok.t === 'table') return { k: 'table', name: tok.v };
    if (tok.t === 'op' && tok.v === '(') { const e = logic(); if (!e || !isOp(')')) return null; take(); return e; }
    if (tok.t === 'id') {
      if (!isOp('(')) return { k: 'name', name: tok.v };     // a bare table name, or a unit like YEAR
      take();
      const args = [];
      while (!isOp(')')) {
        if (!peek()) return null;
        const a = logic(); if (!a) return null;
        args.push(a);
        if (isOp(',')) take(); else if (!isOp(')')) return null;
      }
      take();
      return { k: 'call', fn: tok.v.toUpperCase(), args };
    }
    return null;
  }
  const tree = logic();
  return tree && p === tokens.length ? tree : null;
}

/* Classify a measure's DAX against the model (`model.column(t, c)`, `model.table(t)`, `model.measure(m)`
   return the model's own spelling, or null; `model.pureFunction(f)`, if given, says whether a DAX
   user-defined function reads nothing from the model). Returns { fields, measures } — as the AI would
   answer — or null. */
function classify(dax, model) {
  const tokens = tokenize(dax);
  const tree = tokens && parse(tokens);
  if (!tree) return null;
  const fields = [], measures = [];
  const field = (name, role, usage) => {
    const had = fields.find(f => f.field === name && f.role === role);
    if (had) { if (!had.usage.split(', ').includes(usage)) had.usage += `, ${usage}`; } else fields.push({ field: name, role, usage });
  };
  const measure = (name, as) => { const had = measures.find(m => m.measure === name); if (!had) measures.push({ measure: name, as }); else if (as === 'value') had.as = 'value'; };
  const colOf = n => (n && n.k === 'col' ? model.column(n.table, n.col) : null);
  const tableOf = n => (n && (n.k === 'table' || (n.k === 'name' && !varOf(n))) ? model.table(n.name) : null);
  const pure = fn => !!(model.pureFunction && model.pureFunction(fn));
  const isConst = n => n && (n.k === 'const' || (n.k === 'neg' && isConst(n.x))
    || (n.k === 'call' && (CONSTANT_CALLS.has(n.fn) || (n.fn === 'DATE' && n.args.length === 3 && n.args.every(isConst))
      || ((n.fn === 'UNICHAR' || pure(n.fn)) && n.args.every(isConst)))));

  // Variables: each name's definition, classified where the name is used, as if written there. A
  // variable is evaluated where it's defined, so one used inside CALCULATE's value doesn't see the
  // filters — left to the AI, as is a variable never used.
  const scopes = [];
  const varOf = n => {
    if (!n || n.k !== 'name') return null;
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(n.name.toUpperCase())) return scopes[i].get(n.name.toUpperCase());
    return null;
  };
  let calcDepth = 0;
  const useVar = (n, how) => { const v = varOf(n); if (!v || (calcDepth && how === value)) return false; v.used = true; return how(v.node); };
  const withVars = (n, how) => {
    const scope = new Map();
    scopes.push(scope);
    for (const [name, node] of n.defs) scope.set(name.toUpperCase(), { node, used: false });
    const ok = how(n.body) && [...scope.values()].every(v => v.used);
    scopes.pop();
    return ok;
  };

  function value(n) {
    if (!n) return false;
    if (isConst(n)) return true;
    if (n.k === 'neg') return value(n.x);
    if (n.k === 'arith') return value(n.left) && value(n.right);
    if (n.k === 'ref') { const m = model.measure(n.name); if (!m) return false; measure(m, 'value'); return true; }
    if (n.k === 'name') return useVar(n, value);
    if (n.k === 'var') return withVars(n, value);
    if (n.k !== 'call') return false;
    const { fn, args } = n;
    if (AGGREGATIONS.has(fn) && args.length === 1) { const c = colOf(args[0]); if (!c) return false; field(c, 'main', fn); return true; }
    // The value shown is the column's selected value (a default, if given, is a constant).
    if (fn === 'SELECTEDVALUE' && (args.length === 1 || (args.length === 2 && isConst(args[1])))) {
      const c = colOf(args[0]); if (!c) return false; field(c, 'main', 'SELECTEDVALUE'); return true;
    }
    // FORMAT(value, format): a format string that's a measure only decides the display — a condition.
    if (fn === 'FORMAT' && (args.length === 2 || args.length === 3)) {
      if (!value(args[0])) return false;
      return args.slice(1).every(a => isConst(a) || (a.k === 'ref' && model.measure(a.name) && (measure(model.measure(a.name), 'condition'), true)));
    }
    if (fn === 'COUNTROWS' && args.length === 1) { const t = tableOf(args[0]); if (!t) return false; field(t, 'main', 'COUNTROWS'); return true; }
    if (fn === 'DIVIDE' && (args.length === 2 || args.length === 3)) return args.every(value);
    // A result made of its arguments' values.
    if ((fn === 'COALESCE' && args.length >= 2) || (fn === 'CONCATENATE' && args.length === 2) || ((fn === 'MIN' || fn === 'MAX') && args.length === 2)) return args.every(value);
    if (['ABS', 'INT', 'UPPER', 'LOWER', 'TRIM'].includes(fn) && args.length === 1) return value(args[0]);
    if (['ROUND', 'ROUNDUP', 'ROUNDDOWN'].includes(fn) && args.length === 2) return value(args[0]) && isConst(args[1]);
    // IF / SWITCH: the tests decide, the branches are the value.
    if (fn === 'IF' && (args.length === 2 || args.length === 3)) return test(args[0]) && args.slice(1).every(value);
    if (fn === 'SWITCH' && args.length >= 3) {
      const [on, ...rest] = args;
      const byTests = on.k === 'call' && on.fn === 'TRUE' && !on.args.length;
      if (!byTests && !test(on)) return false;
      for (let i = 0; i < rest.length; i += 2) {
        if (i + 1 === rest.length) return value(rest[i]);                     // the else branch
        if (!(byTests ? test(rest[i]) : isConst(rest[i])) || !value(rest[i + 1])) return false;
      }
      return true;
    }
    if (fn === 'CALCULATE' && args.length >= 1) {
      calcDepth++; const ok = value(args[0]); calcDepth--;
      return ok && args.slice(1).every(a => filter(a, 'filter'));
    }
    if (TIME_TOTALS.has(fn) && args.length >= 2 && args.length <= 4) {
      const d = colOf(args[1]);
      calcDepth++; const ok = d && value(args[0]); calcDepth--;
      if (!ok) return false;
      field(d, 'helper', 'time intelligence');
      return args.slice(2).every(a => a.k === 'const' || filter(a, 'filter'));
    }
    return false;
  }
  // What an IF or SWITCH decides by: a measure only tested is a condition; a column only through
  // ISFILTERED, ISINSCOPE, HASONEVALUE, SELECTEDVALUE or VALUES (a helper, "selection"). Anything
  // else — an aggregate or a column tested — is for the AI, which knows when a main column's check
  // adds no helper.
  function test(n) {
    if (!n) return false;
    if (isConst(n)) return true;
    if (n.k === 'ref') { const m = model.measure(n.name); if (!m) return false; measure(m, 'condition'); return true; }
    if (n.k === 'cmp' || n.k === 'logic' || n.k === 'arith') return test(n.left) && test(n.right);
    if (n.k === 'neg') return test(n.x);
    if (n.k === 'in') return test(n.left) && n.items.every(isConst);
    if (n.k === 'name') return useVar(n, test);
    if (n.k === 'var') return withVars(n, test);
    if (n.k !== 'call') return false;
    const { fn, args } = n;
    if (['NOT', 'ISBLANK'].includes(fn) && args.length === 1) return test(args[0]);
    if ((['ISFILTERED', 'ISINSCOPE', 'HASONEVALUE', 'VALUES'].includes(fn) && args.length === 1)
      || (fn === 'SELECTEDVALUE' && (args.length === 1 || (args.length === 2 && isConst(args[1]))))) {
      const c = colOf(args[0]); if (!c) return false; field(c, 'helper', 'selection'); return true;
    }
    return false;
  }
  function filter(n, usage) {
    if (!n) return false;
    if (n.k === 'cmp') {
      const [c, other] = colOf(n.left) ? [colOf(n.left), n.right] : [colOf(n.right), n.left];
      if (!c || !isConst(other)) return false;
      field(c, 'helper', usage); return true;
    }
    if (n.k === 'in') { const c = colOf(n.left); if (!c || !n.items.every(isConst)) return false; field(c, 'helper', usage); return true; }
    if (n.k === 'logic') return filter(n.left, usage) && filter(n.right, usage);
    if (n.k !== 'call') return false;
    const { fn, args } = n;
    if (fn === 'KEEPFILTERS' && args.length === 1) return filter(args[0], 'keeps filters');
    if (REMOVES.has(fn)) {
      if (!args.length) return fn !== 'ALLNOBLANKROW';          // REMOVEFILTERS(), ALL(), ALLSELECTED(): every filter; no column
      return args.length > 0 && args.every(a => { const x = colOf(a) || tableOf(a); if (!x) return false; field(x, 'helper', 'removes filters'); return true; });
    }
    if (fn === 'ALLEXCEPT' && args.length >= 2) {
      const t = tableOf(args[0]); if (!t) return false;
      field(t, 'helper', 'removes filters');
      return args.slice(1).every(a => { const c = colOf(a); if (!c) return false; field(c, 'helper', 'keeps filters'); return true; });
    }
    if ((fn === 'USERELATIONSHIP' && args.length === 2) || (fn === 'CROSSFILTER' && args.length === 3)) {
      const a = colOf(args[0]), b = colOf(args[1]);
      if (!a || !b) return false;
      field(a, 'helper', 'relationship'); field(b, 'helper', 'relationship'); return true;
    }
    if (TIME_TABLES.has(fn) && args.length >= 1) {
      const d = colOf(args[0]); if (!d) return false;
      // The rest: a number of periods, a YEAR/QUARTER/MONTH/DAY unit, a year-end text — all constants.
      if (!args.slice(1).every(a => isConst(a) || (a.k === 'name' && UNITS.has(a.name.toUpperCase())))) return false;
      field(d, 'helper', 'time intelligence'); return true;
    }
    return false;
  }
  return value(tree) ? { fields, measures } : null;
}

module.exports = { tokenize, parse, classify };
