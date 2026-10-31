/** Small outline icons (24×24, stroke = currentColor). Decorative: always hidden from screen readers. */
const paths = {
  news: 'M4 5h13a2 2 0 0 1 2 2v11a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V5Zm15 4h1a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2M8 9h7M8 13h7M8 17h4',
  posts: 'M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z',
  saved: 'M6 4h12v17l-6-4-6 4V4Z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4a2 2 0 0 0 4 0',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8Zm8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  check: 'M5 12l4 4L19 6',
} as const;

export function Icon({ name, className = 'size-6' }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
