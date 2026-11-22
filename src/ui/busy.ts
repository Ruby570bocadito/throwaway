import { useCallback, useEffect, useState } from 'react';
import type { BusyEvent, CloudModel } from '../framework';
import { tr } from '../i18n';

/** What the dock says while the cloud is busy, instead of a spinner that looks stuck. */
export const busyText = (e: BusyEvent) => {
  if (e.kind === 'switch')
    return tr(
      `The cloud model is busy, so Throwaway switched to a backup model (${e.to}).`,
      `El modelo de la nube está ocupado, así que Throwaway ha pasado a un modelo de reserva (${e.to}).`,
    );
  const s = Math.max(1, Math.round(e.delayMs / 1000));
  return tr(`The cloud model is busy: trying again in ${s} s.`, `El modelo de la nube está ocupado: se vuelve a intentar en ${s} s.`);
};

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
