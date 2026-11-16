// Word-level diff (longest common subsequence) between your original and the version you would post.
// Pure and small: posts are a few hundred words, so the O(n·m) table is fine.

export type DiffPart = { text: string; op: 'same' | 'removed' | 'added' };

const tokens = (s: string) => s.match(/\S+\s*/g) ?? [];
const key = (t: string) => t.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function diffWords(original: string, final: string): DiffPart[] {
  const a = tokens(original);
  const b = tokens(final);
  const ka = a.map(key);
  const kb = b.map(key);
  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffPart[] = [];
  const push = (text: string, op: DiffPart['op']) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ text, op });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      push(b[j], 'same');
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push(a[i++], 'removed');
    else push(b[j++], 'added');
  }
  while (i < a.length) push(a[i++], 'removed');
  while (j < b.length) push(b[j++], 'added');
  return out;
}
