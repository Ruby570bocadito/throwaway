/** Chrome built-in model availability (read-only; inference still goes through Firebase AI Logic). No Firebase import here. */
export async function deviceModelStatus(): Promise<'available' | 'downloadable' | 'unavailable'> {
  const LM = (globalThis as unknown as { LanguageModel?: { availability: (o?: unknown) => Promise<string> } }).LanguageModel;
  if (!LM) return 'unavailable';
  try {
    // Same expected inputs the AI Logic Chrome adapter uses by default (text + image).
    const s = await LM.availability({ expectedInputs: [{ type: 'text' }, { type: 'image' }], expectedOutputs: [{ type: 'text' }] });
    if (s === 'available') return 'available';
    if (s === 'downloadable' || s === 'downloading') return 'downloadable';
  } catch {
    /* ignore */
  }
  return 'unavailable';
}
