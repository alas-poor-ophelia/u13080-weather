/**
 * JSON with comments, for hand-edited text areas. Strips line (`//`) and
 * block comments outside string literals and drops trailing commas before `}` / `]`,
 * then hands the rest to JSON.parse (which still reports real syntax errors).
 * Pure; used by the zone editor so annotated examples can be pasted verbatim.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      // copy a string literal verbatim, honouring escapes
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === ",") {
      // trailing comma: nothing but whitespace/comments before a closer
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j]!)) j++;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < n && text[j] !== "\n") j++;
        } else if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2);
          j = end === -1 ? n : end + 2;
        } else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseJsonLenient<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}
