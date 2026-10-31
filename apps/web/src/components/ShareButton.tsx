import type { ArticleSummary } from '@locallens/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Share sheet. Works everywhere: plain links to WhatsApp/Telegram/Facebook/X need no special browser support, and
 * "Copy link" falls back to the old copy command where the clipboard API is missing (pages opened over plain http,
 * e.g. a phone on the same Wi-Fi). The phone's own share menu is offered too when the browser has one.
 */
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function ShareButton({ article, className }: { article: ArticleSummary; className: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const url = `${location.origin}/articles/${article.slug}`;
  const message = `${article.headline}\n${url}`;
  const targets = [
    { name: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(message)}`, color: 'bg-[#25D366] text-white' },
    { name: 'Telegram', href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(article.headline)}`, color: 'bg-[#229ED9] text-white' },
    { name: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, color: 'bg-[#1877F2] text-white' },
    { name: 'X', href: `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(article.headline)}`, color: 'bg-black text-white' },
  ];
  const canNativeShare = typeof navigator.share === 'function';

  return (
    <>
      <button type="button" aria-haspopup="dialog" onClick={() => { setCopied(null); setOpen(true); }} className={className}>
        {t('shorts.share')}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-stone-900/40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div role="dialog" aria-modal="true" aria-label={t('share.title')} className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-3xl rounded-t-2xl bg-white p-4 pb-6 shadow-2xl">
            <p className="mb-1 font-semibold">{t('share.title')}</p>
            <p className="mb-3 line-clamp-2 text-sm text-stone-600" lang={article.language}>
              {article.headline}
            </p>
            <div className="grid grid-cols-4 gap-2">
              {targets.map((s) => (
                <a key={s.name} href={s.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className={`grid min-h-14 place-items-center rounded-xl text-xs font-bold ${s.color}`}>
                  {s.name}
                </a>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={async () => setCopied((await copyText(url)) ? 'yes' : 'no')}
                className="min-h-11 rounded-xl border border-stone-300 text-sm font-semibold hover:bg-stone-50"
              >
                {copied === 'yes' ? t('share.copied') : t('share.copy')}
              </button>
              {canNativeShare && (
                <button
                  type="button"
                  onClick={() => void navigator.share({ title: article.headline, text: article.summary, url }).then(() => setOpen(false), () => undefined)}
                  className="min-h-11 rounded-xl border border-stone-300 text-sm font-semibold hover:bg-stone-50"
                >
                  {t('share.more')}
                </button>
              )}
            </div>
            {copied === 'no' && <p className="mt-2 break-all text-xs text-stone-600">{t('share.copyManually')} {url}</p>}
            <button type="button" onClick={() => setOpen(false)} className="mt-3 min-h-11 w-full rounded-xl bg-stone-100 font-medium">
              {t('mfa.cancel')}
            </button>
          </div>
        </>
      )}
    </>
  );
}
