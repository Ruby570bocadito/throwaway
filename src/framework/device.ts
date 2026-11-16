/**
 * Chrome built-in model availability (read-only; inference still goes through Firebase AI Logic). No Firebase import here.
 * If Chrome does not answer within `timeoutMs`, the model counts as unavailable: the app then runs in degraded mode
 * (you edit, it attacks), which never sends private data anywhere, instead of waiting on a spinner.
 */
export async function deviceModelStatus(timeoutMs = 10_000): Promise<'available' | 'downloadable' | 'unavailable'> {
  const LM = (globalThis as unknown as { LanguageModel?: { availability: (o?: unknown) => Promise<string> } }).LanguageModel;
  if (!LM) return 'unavailable';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Same expected inputs the AI Logic Chrome adapter uses by default (text + image).
    const s = await Promise.race([
      LM.availability({ expectedInputs: [{ type: 'text' }, { type: 'image' }], expectedOutputs: [{ type: 'text' }] }),
      new Promise<string>((resolve) => (timer = setTimeout(() => resolve('unavailable'), timeoutMs))),
    ]);
    if (s === 'available') return 'available';
    if (s === 'downloadable' || s === 'downloading') return 'downloadable';
  } catch {
    /* ignore */
  } finally {
    clearTimeout(timer);
  }
  return 'unavailable';
}
