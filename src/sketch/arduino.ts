// Turns an Arduino sketch (C++) into JavaScript the program thread can run. It handles what robot and
// ESP32 sketches are made of: #define and #if, typed variables and functions (with default arguments),
// arrays, structs, lambdas, range-for, static locals, casts, integer division of int variables, String
// methods, objects of library classes. Not a C++ compiler: classes with methods, templates and most
// pointer work aren't supported.
import { conditionTrue } from './condition';

const TYPES =
  '(?:void|int|long|short|float|double|bool|boolean|byte|char|String|word|size_t|auto|u?int(?:8|16|32|64)_t)';
const QUAL = '(?:(?:const|static|volatile|unsigned|signed)\\s+)*';

/** Text in quotes is set aside first (a web page's words must not be "translated"), and C++ raw
 *  strings, R"rawliteral( ... )rawliteral" (how ESP32 sketches write their pages), become JS
 *  template literals. Each keeps its line count, so error line numbers still match the sketch. */
function protectStrings(s: string) {
  const saved: { token: string; js: string }[] = [];
  const keep = (js: string, lines: number) => {
    const token = `__BW_STR_${saved.length}__`;
    saved.push({ token: token + '\n'.repeat(lines), js });
    return token + '\n'.repeat(lines);
  };
  s = s.replace(/R"([^(\s"\\]{0,16})\(([\s\S]*?)\)\1"/g, (_m, _d, body: string) =>
    keep('`' + body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`', (body.match(/\n/g) ?? []).length));
  s = s.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => keep(m, 0));
  // C joins strings written side by side ("abc" "def", across lines too): JS needs a +
  s = s.replace(/(__BW_STR_\d+__)(\s+)(?=__BW_STR_\d+__)/g, '$1 +$2');
  return { s, restore: (out: string) => saved.reduceRight((acc, x) => acc.split(x.token).join(x.js), out) };
}

/** #include, #define, #if / #ifdef / #ifndef / #elif / #else / #endif. Lines in a branch that isn't
 *  taken become empty (line numbers still match the sketch). */
function preprocess(s: string, boardDefines: Record<string, number>) {
  const defs = new Map<string, number>(Object.entries(boardDefines));
  const stack: { active: boolean; taken: boolean; parent: boolean }[] = [];
  const on = () => stack.every((f) => f.active);
  return s.split('\n').map((line) => {
    const d = /^\s*#\s*(\w+)\s*(.*?)\s*$/.exec(line);
    if (!d) return on() ? line : '';
    const [, kw, rest] = d;
    if (kw === 'if' || kw === 'ifdef' || kw === 'ifndef') {
      const parent = on();
      const yes = kw === 'ifdef' ? defs.has(rest) : kw === 'ifndef' ? !defs.has(rest) : conditionTrue(rest, defs);
      stack.push({ active: parent && yes, taken: yes, parent });
      return '';
    }
    if (kw === 'elif') {
      const f = stack[stack.length - 1];
      if (f) { const yes = !f.taken && conditionTrue(rest, defs); f.active = f.parent && yes; f.taken ||= yes; }
      return '';
    }
    if (kw === 'else') {
      const f = stack[stack.length - 1];
      if (f) { f.active = f.parent && !f.taken; f.taken = true; }
      return '';
    }
    if (kw === 'endif') { stack.pop(); return ''; }
    if (!on()) return '';
    if (kw === 'define') {
      const m = /^(\w+)(?:\s+(.+))?$/.exec(rest);
      if (!m || /^\w+\(/.test(rest)) return ''; // (function-like macros: not supported)
      const v = (m[2] ?? '').trim();
      const num = /^0[xX]/.test(v) ? v.replace(/[uUlL]+$/, '') : v.replace(/[uUlLfF]+$/, '');
      defs.set(m[1], /^(?:-?\d+(?:\.\d+)?|0[xX][0-9A-Fa-f]+)$/.test(num) ? Number(num) : 1);
      return v ? `const ${m[1]} = ${v};` : '';
    }
    if (kw === 'undef') { defs.delete(rest); return ''; }
    return ''; // #include, #pragma, #error...
  }).join('\n');
}

const INT_T = '(?:int|long|short|byte|word|size_t|unsigned|u?int(?:8|16|32|64)_t)';

/** a parameter list as JS: names, with their default values ("bool on = true" -> "on = true") */
function jsParams(params: string, ints?: Set<string>) {
  if (params.trim() === 'void' || !params.trim()) return '';
  return params.split(',').map((p) => {
    const eq = p.indexOf('=');
    const decl = eq >= 0 ? p.slice(0, eq) : p, def = eq >= 0 ? p.slice(eq + 1).trim() : '';
    const name = decl.trim().replace(/\[[^\]]*\]/g, '').split(/[\s*&]+/).filter(Boolean).pop() ?? '';
    if (ints && new RegExp(`^\\s*(?:const\\s+)?(?:unsigned\\s+)?${INT_T}\\b`).test(decl) && !/\[/.test(decl)) ints.add(name);
    return name ? (def ? `${name} = ${def}` : name) : '';
  }).filter(Boolean).join(', ');
}

/** The index of the "}" closing the "{" at i. */
function closeBrace(s: string, i: number) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j;
  }
  return s.length - 1;
}

export function arduinoToJs(src: string, classes: string[] = [], boardDefines: Record<string, number> = {}): string {
  const prot = protectStrings(src.replace(/\r\n/g, '\n'));
  let s = prot.s;
  classes = [...classes];
  // comments out (keeping their lines): braces or code in them must not count
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  s = preprocess(s, boardDefines);
  // (before anything looks for arrays: "const char header[66] PROGMEM = {...};")
  s = s.replace(/\s*\bPROGMEM\b/g, (m) => m.replace(/[^\n]/g, ''));
  // C's many-word integer types as one word each ("long unsigned int rxId;", "long long t;",
  // "short int s;", "signed char c;"): the rules below know the one-word names
  s = s
    .replace(/\bunsigned\s+long\s+long(?:\s+int)?\b/g, 'uint64_t')
    .replace(/\b(?:signed\s+)?long\s+long(?:\s+int)?\b/g, 'int64_t')
    .replace(/\blong\s+unsigned(?:\s+int)?\b|\bunsigned\s+long\s+int\b/g, 'unsigned long')
    .replace(/\bunsigned\s+short(?:\s+int)?\b|\bshort\s+unsigned(?:\s+int)?\b/g, 'uint16_t')
    .replace(/\b(?:signed\s+)?short\s+int\b|\bsigned\s+short\b/g, 'short')
    .replace(/\b(?:signed\s+)?long\s+int\b|\bsigned\s+long\b/g, 'long')
    .replace(/\bsigned\s+char\b/g, 'int8_t')
    .replace(/\bsigned\s+int\b/g, 'int')
    // (the ESP32's own names for plain numbers: esp_err_t result = esp_now_send(...);)
    .replace(/\b(?:esp_err_t|esp_now_send_status_t|wl_status_t|wifi_mode_t|wifi_interface_t|gpio_num_t|u_result|_u8|_u16|_u32)\b(?=\s+\w)/g, 'int')
    // pointer casts: "(uint8_t *) &myData", "(const char*)buf", "(byte *) data" (in JS the thing itself)
    .replace(/\(\s*(?:const\s+)?(?:unsigned\s+)?[A-Za-z_]\w*\s*\*+\s*\)\s*(?=[&\w("'])/g, '');
  // structs: a class whose fields start at zero ("struct Move { float from[5]; uint32_t t0; } mv = {};")
  s = s.replace(/\b(typedef\s+)?struct\s+(\w*)\s*\{([^{}]*)\}\s*([^;]*);/g, (m, td: string | undefined, name: string, body: string, after: string) => {
    const lines = (m.match(/\n/g) ?? []).length;
    let vars = after.trim();
    let aliases: string[] = [];
    if (!name) { name = vars.split(',')[0].trim(); vars = ''; } // typedef struct { ... } Name;
    // "typedef struct name { ... } alias;": the names after it are other names for the type, not variables
    if (td) { aliases = vars.split(',').map((x) => x.replace(/\*/g, '').trim()).filter((x) => /^\w+$/.test(x) && x !== name); vars = ''; }
    const fields: string[] = [], init: string[] = [];
    for (const f of body.split(';').map((x) => x.trim()).filter(Boolean)) {
      const fm = new RegExp(`^(?:(?:const|volatile|unsigned|signed)\\s+)*(\\w+)\\s*\\*?\\s+(.+)$`).exec(f);
      if (!fm) continue;
      const t = fm[1];
      const zero = t === 'String' ? '""' : t === 'bool' || t === 'boolean' ? 'false' : /^[A-Z]/.test(t) && classes.includes(t) ? `new ${t}()` : '0';
      for (const decl of fm[2].split(',')) {
        const a = /^\s*(\w+)\s*\[\s*([^\]]+?)\s*\]/.exec(decl), v = /^\s*(\w+)\s*=\s*(.+)$/.exec(decl);
        // (a char array is a text: strcpy() into it, print it)
        if (a && t === 'char') { fields.push(a[1]); init.push(`this.${a[1]} = "";`); }
        else if (a) { fields.push(a[1]); init.push(`this.${a[1]} = new Array(${a[2]}).fill(${zero});`); }
        else if (v) { fields.push(v[1]); init.push(`this.${v[1]} = ${v[2]};`); }
        else if (decl.trim()) { fields.push(decl.trim()); init.push(`this.${decl.trim()} = ${zero};`); }
      }
    }
    classes.push(name, ...aliases);
    const alias = aliases.map((x) => `const ${x} = ${name};`).join(' ');
    const decls = vars ? vars.split(/,(?![^{]*\})/).map((d) => {
      const dm = /^\s*(\w+)\s*(?:=\s*\{([^}]*)\})?\s*$/.exec(d);
      if (!dm) return '';
      const vals = (dm[2] ?? '').trim();
      return vals ? `let ${dm[1]} = __struct(new ${name}(), ${JSON.stringify(fields)}, [${vals}]);` : `let ${dm[1]} = new ${name}();`;
    }).join(' ') : '';
    return `class ${name} { constructor() { ${init.join(' ')} } } ${alias} ${decls}` + '\n'.repeat(lines);
  });
  // C's string copies into char arrays (texts here): strcpy(dst, src) / strncpy(dst, src, n) / strcat
  s = s
    .replace(/\bstrcpy\s*\(\s*([\w.]+(?:\[[^\]]*\])?)\s*,\s*([^;]+?)\)\s*;/g, '$1 = String($2);')
    .replace(/\bstrncpy\s*\(\s*([\w.]+(?:\[[^\]]*\])?)\s*,\s*([^,;]+?)\s*,\s*([^;]+?)\)\s*;/g, '$1 = String($2).slice(0, $3);')
    .replace(/\bstrcat\s*\(\s*([\w.]+(?:\[[^\]]*\])?)\s*,\s*([^;]+?)\)\s*;/g, '$1 = String($1) + String($2);');
  // numbers into char arrays, the same way: itoa(n, str, 10)
  s = s.replace(/\b(?:itoa|utoa|ltoa|ultoa)\s*\(\s*([^;,]+?)\s*,\s*([\w.]+)\s*,\s*(\w+)\s*\)\s*;/g, '$2 = Number($1).toString($3);');
  // "using namespace ControlTableItem;" (the names are all there anyway)
  s = s.replace(/^\s*using\s+namespace\s+[\w:]+\s*;/gm, '');
  // ISR attributes (ESP32 / ESP8266): "void IRAM_ATTR onPulse() {"
  s = s.replace(/\b(IRAM_ATTR|ICACHE_RAM_ATTR|ARDUINO_ISR_ATTR)\s+/g, '');
  // casts to a class's type: "(MFRC522::StatusCode) x" -> x
  s = s.replace(/\(\s*[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+\s*\)\s*(?=[\w(])/g, '');
  // objects of a class's own type: "MFRC522::MIFARE_Key key;" -> let key = new MFRC522.MIFARE_Key();
  s = s.replace(/^(\s*)([A-Za-z_]\w*)::([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/gm, '$1let $4 = new $2.$3();');
  s = s.replace(/^(\s*)([A-Za-z_]\w*)::([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=/gm, '$1let $4 =');
  // a class's constant: "AccelStepper::HALF4WIRE" -> AccelStepper.HALF4WIRE
  s = s.replace(/\b([A-Za-z_]\w*)::([A-Za-z_]\w*)/g, '$1.$2');
  // "&(x.y)": the thing itself
  s = s.replace(/([(,]\s*)&\(/g, '$1(');
  // forward declarations: "void blink(int n);"
  s = s.replace(new RegExp(`^\\s*${QUAL}${TYPES}\\s*\\*?\\s+\\w+\\s*\\([^)]*\\)\\s*;\\s*$`, 'gm'), '');
  // function definitions: "int twice(int x = 2) {" -> "function twice(x = 2) {"
  const ints = new Set<string>();
  s = s.replace(new RegExp(`\\b${QUAL}${TYPES}\\s*[*&]?\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{`, 'g'), (_m, name, params: string) =>
    `function ${name}(${jsParams(params, ints)}) {` + '\n'.repeat((params.match(/\n/g) ?? []).length));
  // lambdas: "server.on("/", []() { ... });" -> "server.on("/", () => { ... });"
  s = s.replace(/(?<=[(,=]\s*)\[[^\]]*\]\s*\(([^)]*)\)\s*(?:mutable\s*)?(?:->\s*[\w:<>]+\s*)?\{/g, (_m, params: string) => `(${jsParams(params)}) => {`);
  // range-for: "for (uint8_t c : init)" -> "for (let c of init)"
  s = s.replace(new RegExp(`\\bfor\\s*\\(\\s*(?:const\\s+)?(?:${TYPES}|[A-Za-z_]\\w*)\\s*[&*]?\\s*(\\w+)\\s*:\\s*([^;)]+)\\)`, 'g'), 'for (let $1 of $2)');
  // static locals keep their value between calls: the function gets them from around it
  //   "void tick() { static int n = 0; ... }" -> "const tick = (() => { int n = 0; return function tick() { ... }; })();"
  for (let from = 0; ;) {
    const re = /\bfunction\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
    re.lastIndex = from;
    const m = re.exec(s);
    if (!m) break;
    const open = m.index + m[0].length - 1, close = closeBrace(s, open);
    const body = s.slice(open + 1, close);
    const statics: string[] = [];
    const body2 = body.replace(/(^|[;{}])([ \t]*)static\s+([^;]*;)/gm, (_x, pre: string, ind: string, decl: string) => { statics.push(decl); return pre + ind; });
    if (!statics.length) { from = open + 1; continue; }
    const head = `const ${m[1]} = (() => { ${statics.join(' ')} return function ${m[1]}(${m[2]}) {`;
    s = s.slice(0, m.index) + head + body2 + '}; })();' + s.slice(close + 1);
    from = m.index + head.length;
  }
  // templates on the usual helpers: "max<uint32_t>(a, b)" -> max(a, b); static_cast<int>(x) -> Math.trunc(x)
  s = s.replace(/\b(max|min|constrain|abs|map)\s*<[^<>()]*>\s*\(/g, '$1(');
  s = s.replace(new RegExp(`\\bstatic_cast\\s*<\\s*(?:unsigned\\s+)?${INT_T}\\s*>\\s*\\(`, 'g'), 'Math.trunc(');
  s = s.replace(/\b(?:static|reinterpret|const)_cast\s*<[^<>]*>\s*\(/g, '(');
  // casts that change the number: to whole numbers, and to 8 / 16 / 32-bit sizes (they wrap round)
  const CASTS: Record<string, string> = { int16_t: '__i16', int8_t: '__i8', uint8_t: '__u8', byte: '__u8', uint16_t: '__u16', 'unsigned short': '__u16', uint32_t: '__u32', 'unsigned long': '__u32', 'unsigned int': '__u32', int: 'Math.trunc', long: 'Math.trunc', short: '__i16', int32_t: 'Math.trunc' };
  s = s.replace(/\(\s*(int16_t|int8_t|uint8_t|byte|uint16_t|unsigned\s+short|uint32_t|unsigned\s+long|unsigned\s+int|int|long|short|int32_t)\s*\)\s*\(/g, (_m, t: string) => `${CASTS[t.replace(/\s+/, ' ')]}(`);
  s = s.replace(/\(\s*char\s*\)\s*([\w.]+(?:\([^()]*\))?(?:\[[^\]]*\])?)/g, '__char($1)');
  // and on a plain operand: "(int)pixels[i]", "(byte)x", "(long)obj.read()" (a cast binds tightest)
  s = s.replace(/\(\s*(int16_t|int8_t|uint8_t|byte|uint16_t|unsigned\s+short|uint32_t|unsigned\s+long|unsigned\s+int|int|long|short|int32_t)\s*\)\s*([A-Za-z_\d][\w.]*(?:\([^()]*\))?(?:\[[^\]]*\])*)/g,
    (_m, t: string, x: string) => `${CASTS[t.replace(/\s+/, ' ')]}(${x})`);
  // "(float)k / 2": a fraction (not whole-number division of an int)
  s = s.replace(/\(\s*(?:float|double)\s*\)\s*([A-Za-z_\d][\w.]*(?:\([^()]*\))?(?:\[[^\]]*\])*)/g, '(+$1)');
  // whole-number division of int variables: C++ drops the fraction ("y / 8" with int y)
  for (const m of s.matchAll(new RegExp(`\\b(?:(?:const|static|volatile|unsigned|signed)\\s+)*${INT_T}\\s+(\\w+)\\s*(?=[=;,)])`, 'g'))) ints.add(m[1]);
  for (const m of s.matchAll(new RegExp(`\\b(?:float|double)\\s+(\\w+)\\s*(?=[=;,)\\[])`, 'g'))) ints.delete(m[1]);
  s = s.replace(/(?<![\w.])([A-Za-z_]\w*)\s*\/\s*([A-Za-z_]\w*|\d+)(?![\w.(\[])/g, (m0, a: string, b: string) =>
    ints.has(a) && (/^\d+$/.test(b) || ints.has(b)) ? `Math.trunc(${a} / ${b})` : m0);
  // (and millis() / 1000: millis() is a whole number, so is what it's divided into)
  s = s.replace(/\b(millis|micros)\(\s*\)\s*\/\s*(\d+)(?![\w.])/g, 'Math.trunc($1() / $2)');
  // a char holds a character: "char c = Serial.read();" -> let c = __char(Serial.read());
  s = s.replace(/\b(?:const\s+)?(?:unsigned\s+)?char\s+(\w+)\s*=\s*([^;'`]+);/g, (m0, n: string, e: string) => (/__BW_STR_/.test(e) ? m0 : `let ${n} = __char(${e.trim()});`));
  // String methods that change the string in C++ ("name.toLowerCase();"): JS strings don't change
  s = s.replace(/(^|[;{}]\s*)([A-Za-z_][\w.]*(?:\[[^\]]*\])?)\.(toLowerCase|toUpperCase|trim)\(\s*\)\s*;/gm, '$1$2 = $2.$3();');
  s = s.replace(/(^|[;{}]\s*)([A-Za-z_][\w.]*)\.replace\(([^;]*)\)\s*;/gm, '$1$2 = __strReplace($2, $3);');
  s = s.replace(/\.length\(\s*\)/g, '.length');
  // arrays of arrays: "char keys[4][4] = {{'1','2','3','A'}, ...};" -> let keys = [['1','2','3','A'], ...];
  s = s.replace(new RegExp(`\\b${QUAL}${TYPES}\\s+(\\w+)\\s*(?:\\[[^\\]]*\\]){2,}\\s*=\\s*\\{`, 'g'), (_m, n) => `let ${n} = __BW_NEST__{`);
  while (s.includes('__BW_NEST__{')) {
    const i = s.indexOf('__BW_NEST__{');
    let depth = 0, j = i + '__BW_NEST__'.length;
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) break;
    }
    const body = s.slice(i + '__BW_NEST__'.length, j + 1).replace(/\{/g, '[').replace(/\}/g, ']');
    s = s.slice(0, i) + body + s.slice(j + 1);
  }
  // what each simple variable was declared as (for "&x" and sizeof(x))
  const declared = new Map<string, { type: string; n: number }>();
  for (const m of s.matchAll(new RegExp(`\\b${QUAL}(${TYPES})\\s+(\\w+)\\s*(?:\\[\\s*(\\d*)\\s*\\])?\\s*(?=[=;,)\\[])`, 'g'))) {
    const unsigned = /\bunsigned\b/.test(m[0]);
    declared.set(m[2], { type: (unsigned && !/^u/.test(m[1]) ? 'u' : '') + m[1], n: m[3] ? Number(m[3]) : m[0].includes('[') ? -1 : 0 });
  }
  const sizeOfType = (t: string) =>
    /char|byte|bool|int8|uint8/.test(t) ? 1 : /short|int16|word|^u?int$/.test(t) ? 2 : /long|float|double|int32|size_t/.test(t) ? 4 : /int64/.test(t) ? 8 : 0;
  // sizeof(x) of a variable declared here: its bytes (AVR sizes: int 2, long and float 4)
  s = s.replace(/\bsizeof\s*\(\s*([A-Za-z_]\w*)\s*\)(?!\s*\/\s*sizeof)/g, (m0, name: string) => {
    const d = declared.get(name);
    const unit = d ? sizeOfType(d.type.replace(/^u(?=[a-z])/, '')) : sizeOfType(name);
    if (d && unit && d.n > 0) return String(unit * d.n);
    if (d && unit && d.n === 0) return String(unit);
    if (!d && unit) return String(unit); // sizeof(int)
    return `__sizeof(${name})`;
  });
  // "&x" handed to a function: the variable itself (a library can set it); "&arr[0]" and "&s.f"
  // just pass the thing (JS passes objects and arrays by reference anyway)
  s = s.replace(/([(,]\s*)&([A-Za-z_]\w*)(?![\w.[(])/g, (_m, pre: string, name: string) => {
    const d = declared.get(name);
    const t = d ? (/float|double/.test(d.type) ? 'f' : /char/.test(d.type) && d.n !== 0 ? 's' : /bool/.test(d.type) ? 'b' : /^u|byte|word|size_t/.test(d.type) ? 'u' : 'i') : '';
    const size = d ? (sizeOfType(d.type.replace(/^u(?=[a-z])/, '')) || 4) * (d.n > 0 ? d.n : 1) : 0;
    // (no ";" in it: declarations below are split at the first one, "LCD lcd(&Wire, 0x27);")
    return `${pre}__ref(() => ${name}, (__v) => (${name} = __v), '${t}', ${size})`;
  });
  s = s.replace(/([(,]\s*)&(?=[A-Za-z_])/g, '$1');
  // "port = &Serial1;" (a pointer set to an object): the object itself
  s = s.replace(/([^=!<>]=\s*)&(?=[A-Za-z_])/g, '$1');
  // arrays: "int notes[] = {1, 2};" / "int buf[8];" / "const char *NAMES[3] = {...};" / "uint8_t fb[128 * 64 / 8];"
  const arrays = new Set<string>();
  s = s.replace(new RegExp(`\\b${QUAL}${TYPES}(?:\\s+|\\s*\\*\\s*)(\\w+)\\s*(\\[[^\\]]*\\])+\\s*=\\s*\\{([^}]*)\\}`, 'g'), (_m, n, _d, items) => { arrays.add(n); return `let ${n} = [${items}]`; });
  // ("float a[2] = {1, 2}, b[2] = {3, 4};": the ones after the first)
  for (let i = 0; i < 8; i++) s = s.replace(/(=\s*\[[^\]]*\])\s*,\s*(\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}/g, (_m, a, n, items) => { arrays.add(n); return `${a}, ${n} = [${items}]`; });
  s = s.replace(new RegExp(`\\b${QUAL}${TYPES}(?:\\s+|\\s*\\*\\s*)(\\w+)\\s*\\[\\s*([^\\]]+?)\\s*\\]\\s*;`, 'g'), (_m, n, size) => { arrays.add(n); return `let ${n} = new Array(${size}).fill(0);`; });
  // a pointer into an array handed to a function ("Wire.write(fb + i, 16)"): the rest of it from there
  s = s.replace(/([(,]\s*)([A-Za-z_]\w*)\s*\+\s*([\w.]+)(?=\s*[,)])/g, (m0, pre: string, a: string, i: string) => (arrays.has(a) ? `${pre}${a}.slice(${i})` : m0));
  // object declarations: "Servo arm;" / "Servo a, b;"
  // (and the same for every class an #include'd library declares: "LedControl lc(12, 11, 10, 1);",
  //  "LiquidCrystal_I2C lcd = LiquidCrystal_I2C(0x27, 16, 2);")
  for (const cls of ['Servo', ...classes].filter((c) => /^[A-Za-z_]\w*$/.test(c))) {
    s = s.replace(new RegExp(`^(\\s*)${cls}\\s+([^;]+);`, 'gm'), (_m, ind: string, decls: string) => {
      const parts: string[] = [];
      let depth = 0, cur = '';
      for (const ch of decls) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
        } else cur += ch;
      }
      parts.push(cur);
      return parts
        .map((d) => {
          const t = d.trim();
          const call = /^(\w+)\s*\(([\s\S]*)\)$/.exec(t);
          if (call) return `${ind}let ${call[1]} = new ${cls}(${call[2]});`;
          const assign = new RegExp(`^(\\w+)\\s*=\\s*(?:new\\s+)?${cls}\\s*\\(([\\s\\S]*)\\)$`).exec(t);
          if (assign) return `${ind}let ${assign[1]} = new ${cls}(${assign[2]});`;
          if (t.includes('=')) return `${ind}let ${t};`; // "IPAddress ip = WiFi.localIP();"
          return `${ind}let ${t} = new ${cls}();`;
        })
        .join('\n');
    });
  }
  // whole-number variables set from a division: C++ drops the fraction ("int s = millis() / 1000;")
  s = s.replace(new RegExp(`\\b${QUAL}(?:int|long|short|byte|word|size_t|u?int(?:8|16|32|64)_t)\\s+(\\w+)\\s*=\\s*([^;{}]*\\/[^;{}]*);`, 'g'), (_m, n, e) => `let ${n} = Math.trunc(${e});`);
  // variables declared without a value start at zero (C++ globals do): "int n;" "String s;" "bool b;"
  s = s.replace(new RegExp(`\\b${QUAL}(${TYPES})\\s+(\\w+(?:\\s*,\\s*\\w+)*)\\s*;`, 'g'), (m0, t: string, names: string) => {
    if (t === 'void' || t === 'auto') return m0;
    const zero = t === 'String' ? '""' : t === 'bool' || t === 'boolean' ? 'false' : t === 'char' ? '"\\0"' : '0';
    return `let ${names.split(',').map((n) => `${n.trim()} = ${zero}`).join(', ')};`;
  });
  // variables (also in "for (int i = 0; ...)"): the type becomes let
  s = s.replace(new RegExp(`\\b${QUAL}${TYPES}\\s*\\*?\\s+(?=\\w+\\s*(=|;|,|\\)|\\[))`, 'g'), 'let ');
  // a text held in a char array: "const char page[] = R"(...)";" -> let page = `...`;
  s = s.replace(/(\blet\s+\w+)\s*\[\s*\w*\s*\]\s*=\s*(?=__BW_STR_)/g, '$1 = ');
  // const-qualified things that are now "let" but were const: fine as let
  // casts: (int)x, (float)(a+b)
  s = s.replace(new RegExp(`\\(\\s*${QUAL}${TYPES}\\s*\\)\\s*`, 'g'), '');
  // little things
  s = s.replace(/\bsizeof\s*\(\s*(\w+)\s*\)\s*\/\s*sizeof\s*\(\s*\1\s*\[\s*0\s*\]\s*\)/g, '$1.length');
  s = s.replace(/\bF\(\s*(__BW_STR_\d+__\n*)\s*\)/g, '$1');
  s = s.replace(/\bNULL\b/g, 'null');
  // number suffixes off (in hex an "f" is a digit: 0xff stays 0xff, only 1.5f and 2f lose theirs)
  s = s.replace(/\b(0[xX][0-9A-Fa-f]+)(?:[uU](?:LL|ll|[lL])?|(?:LL|ll|[lL])[uU]?)\b/g, '$1');
  s = s.replace(/\b(\d+(?:\.\d+)?)(?:ULL|ull|LL|ll|UL|ul|L|l|U|u|f)\b/g, '$1');
  return prot.restore(s);
}
