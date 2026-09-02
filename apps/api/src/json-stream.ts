/** Pull complete JSON values off a MinIO listen stream (NDJSON or concatenated objects). */
export function extractJsonObjects(buf: string): { objects: unknown[]; rest: string } {
  const objects: unknown[] = [];
  let i = 0;
  const n = buf.length;
  while (i < n) {
    while (i < n && (buf[i] === " " || buf[i] === "\n" || buf[i] === "\r" || buf[i] === "\t")) i++;
    if (i >= n) break;
    if (buf[i] !== "{" && buf[i] !== "[") {
      const nl = buf.indexOf("\n", i);
      if (nl < 0) return { objects, rest: buf.slice(i) };
      i = nl + 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < n; j++) {
      const c = buf[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) return { objects, rest: buf.slice(i) };
    const slice = buf.slice(i, end + 1);
    try {
      objects.push(JSON.parse(slice));
    } catch {
      /* skip malformed */
    }
    i = end + 1;
  }
  return { objects, rest: "" };
}
