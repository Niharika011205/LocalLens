import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInstall } from '../pwa';

/** "Install app": the browser's own install dialog on Android/desktop, or the Add-to-Home-Screen steps on iPhone. */
export function InstallAppButton({ className, onDone }: { className: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const { mode, install } = useInstall();
  const [iosHelp, setIosHelp] = useState(false);
  if (!mode) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          if (mode === 'prompt') void install().then(() => onDone?.());
          else setIosHelp(true);
        }}
      >
        {t('pwa.install')}
      </button>
      {iosHelp && (
        <div role="dialog" aria-modal="true" aria-label={t('pwa.install')} className="fixed inset-0 z-50 grid place-items-end bg-stone-900/40 p-3 sm:place-items-center" onClick={() => setIosHelp(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-left text-stone-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-2 font-bold">{t('pwa.iosTitle')}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>{t('pwa.ios1')}</li>
              <li>{t('pwa.ios2')}</li>
              <li>{t('pwa.ios3')}</li>
            </ol>
            <button type="button" className="mt-4 min-h-11 w-full rounded-xl bg-stone-100 font-semibold" onClick={() => setIosHelp(false)}>
              {t('pwa.ok')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
