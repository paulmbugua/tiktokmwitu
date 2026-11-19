import type { Metadata } from 'next';
import Feed from './feed';

const title = 'TikTok Mwitu | Kenyan Short Videos & LIVE Streams';
const description = 'Discover short videos from Kenyan creators, watch LIVE streams and join the conversation on TikTok Mwitu. Share your own clips from anywhere in Kenya.';
const socialImage = { url: '/icons/mwitu-512.png', width: 512, height: 512, alt: 'TikTok Mwitu app icon' };

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: '/' },
  robots: { index: true, follow: true, googleBot: { 'max-image-preview': 'large', 'max-video-preview': -1 } },
  openGraph: {
    title, description, url: '/', siteName: 'TikTok Mwitu', locale: 'en_KE', type: 'website', images: [socialImage],
  },
  twitter: { card: 'summary', title, description, images: [socialImage] },
};

const site = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'TikTok Mwitu',
  url: 'https://tiktokmwitu.co.ke/',
  description,
  inLanguage: 'en-KE',
};

export default function Home() {
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(site) }} />
    <Feed />
  </>;
}
