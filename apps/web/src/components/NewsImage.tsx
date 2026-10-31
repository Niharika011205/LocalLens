import { useState, type ReactNode } from 'react';

/**
 * News photos come from Cloudinary, our own server, or (imported stories) the news site. If a site's photo fails to
 * load, show the fallback instead of a broken image. no-referrer: we do not tell news sites which page a reader is on.
 */
export function NewsImage({ src, className, fallback }: { src: string | null; className: string; fallback?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{fallback ?? null}</>;
  return <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={className} />;
}
