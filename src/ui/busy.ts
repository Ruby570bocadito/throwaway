import { useCallback, useEffect, useState } from 'react';
import type { BusyEvent, CloudModel } from '../framework';

/** What the dock says while the cloud is busy, instead of a spinner that looks stuck. */
export const busyText = (e: BusyEvent) =>
  e.kind === 'switch'
    ? `The cloud model is busy, so Throwaway switched to a backup model (${e.to}).`
    : `The cloud model is busy: trying again in ${Math.max(1, Math.round(e.delayMs / 1000))} s.`;

/**
 * While `active` (an attack is running), the latest busy event of the cloud model, as a sentence. The lab clears it when
 * an attempt lands or a new attack starts.
 */
export function useCloudBusy(cloud: CloudModel, active: boolean): [string, () => void] {
  const [note, setNote] = useState('');
  useEffect(() => (active ? cloud.onBusy((e) => setNote(busyText(e))) : undefined), [cloud, active]);
  const clear = useCallback(() => setNote(''), []);
  return [active ? note : '', clear];
}
