import type { Language } from '@locallens/contracts';

/**
 * News sites whose public RSS feeds we show headlines from. Each was checked on 29 Oct 2026: feed reachable, items
 * carry a photo, and the photos load from other sites. Add a site only through its official feed, and remove it if
 * the publisher asks.
 */
export interface NewsSource {
  id: string;
  name: string;
  siteUrl: string;
  feedUrl: string;
  language: Language;
  enabled: boolean;
}

export const NEWS_SOURCES: NewsSource[] = [
  {
    id: 'thehindu-ap',
    name: 'The Hindu',
    siteUrl: 'https://www.thehindu.com',
    feedUrl: 'https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss',
    language: 'en',
    enabled: true,
  },
  { id: 'tv9telugu-ap', name: 'TV9 Telugu', siteUrl: 'https://tv9telugu.com', feedUrl: 'https://tv9telugu.com/andhra-pradesh/feed', language: 'te', enabled: true },
  { id: 'ntvtelugu-ap', name: 'NTV Telugu', siteUrl: 'https://ntvtelugu.com', feedUrl: 'https://ntvtelugu.com/andhra-pradesh-news/feed', language: 'te', enabled: true },
  { id: '10tv-ap', name: '10TV', siteUrl: 'https://10tv.in', feedUrl: 'https://10tv.in/andhra-pradesh/feed', language: 'te', enabled: true },
  // Added 29 Oct 2026 after the same checks.
  { id: 'thehindu-vijayawada', name: 'The Hindu', siteUrl: 'https://www.thehindu.com', feedUrl: 'https://www.thehindu.com/news/cities/Vijayawada/feeder/default.rss', language: 'en', enabled: true },
  { id: 'thehindu-vizag', name: 'The Hindu', siteUrl: 'https://www.thehindu.com', feedUrl: 'https://www.thehindu.com/news/cities/Visakhapatnam/feeder/default.rss', language: 'en', enabled: true },
  {
    id: 'newindianexpress-ap',
    name: 'The New Indian Express',
    siteUrl: 'https://www.newindianexpress.com',
    feedUrl: 'https://www.newindianexpress.com/states/andhra-pradesh/rssfeed/?id=170&getXmlFeed=true',
    language: 'en',
    enabled: true,
  },
  // Works, but the feed is mostly film news rather than local news: off unless wanted.
  { id: 'telugu360', name: 'Telugu360', siteUrl: 'https://www.telugu360.com', feedUrl: 'https://www.telugu360.com/feed/', language: 'en', enabled: false },
  { id: 'abp-desam-ap', name: 'ABP Desam', siteUrl: 'https://telugu.abplive.com', feedUrl: 'https://telugu.abplive.com/news/andhra-pradesh/feed', language: 'te', enabled: true },
  { id: 'asianet-telugu-ap', name: 'Asianet News Telugu', siteUrl: 'https://telugu.asianetnews.com', feedUrl: 'https://telugu.asianetnews.com/rss/andhra-pradesh', language: 'te', enabled: true },
  { id: 'bigtv-ap', name: 'BIG TV', siteUrl: 'https://www.bigtvlive.com', feedUrl: 'https://www.bigtvlive.com/andhra-pradesh/feed', language: 'te', enabled: true },
  { id: 'sakshi', name: 'Sakshi', siteUrl: 'https://www.sakshi.com', feedUrl: 'https://www.sakshi.com/rss.xml', language: 'te', enabled: true },
];
