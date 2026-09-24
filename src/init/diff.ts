/** Above this many lines per side, no line diff is computed (config files are far smaller). */
const MAX_DIFF_LINES = 4000;

type Op = { type: " " | "-" | "+"; line: string };

function splitLines(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line edit script via longest common subsequence (after trimming the common prefix/suffix). */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * (m + 1) + j] = midA[i] === midB[j]
        ? lcs[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const ops: Op[] = a.slice(0, start).map((line) => ({ type: " ", line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      ops.push({ type: " ", line: midA[i] });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) {
      ops.push({ type: "-", line: midA[i] });
      i += 1;
    } else {
      ops.push({ type: "+", line: midB[j] });
      j += 1;
    }
  }
  ops.push(...a.slice(endA).map((line): Op => ({ type: " ", line })));
  return ops;
}

/**
 * Unified diff (`---`/`+++` headers and `@@` hunks with `context` lines)
 * between two texts; empty when they are equal. A missing side is `/dev/null`.
 */
export function unifiedDiff(filePath: string, before: string | undefined, after: string | undefined, context = 3): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const header = [`--- ${before === undefined ? "/dev/null" : `a/${filePath}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${filePath}`}`];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...header, `@@ diff omitted: ${a.length} -> ${b.length} lines @@`].join("\n");
  }
  const ops = diffOps(a, b);
  const changed = ops.map((op, index) => (op.type === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) {
    // Only line endings or a trailing newline differ.
    return [...header, "@@ whitespace-only change (line endings or trailing newline) @@"].join("\n");
  }

  // Group changes whose context windows overlap into hunks.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }

  const lines = [...header];
  for (const [from, to] of hunks) {
    let oldStart = 1;
    let newStart = 1;
    for (const op of ops.slice(0, from)) {
      if (op.type !== "+") oldStart += 1;
      if (op.type !== "-") newStart += 1;
    }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.type !== "+").length;
    const newCount = slice.filter((op) => op.type !== "-").length;
    lines.push(`@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`);
    lines.push(...slice.map((op) => `${op.type}${op.line}`));
  }
  return lines.join("\n");
}
