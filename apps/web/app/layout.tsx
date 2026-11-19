
import type { Metadata, Viewport } from 'next';
import './style.css';
import './surfaces.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://tiktokmwitu.co.ke'),
  title: 'TikTok Mwitu | Kenyan Short Videos & LIVE Streams',
  description: 'Discover short videos from Kenyan creators, watch LIVE streams and join the conversation on TikTok Mwitu. Share your own clips from anywhere in Kenya.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icons/mwitu-note.svg', type: 'image/svg+xml' },
      { url: '/icons/favicon-32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: { url: '/icons/apple-touch-icon.png', sizes: '180x180' },
  },
  appleWebApp: { capable: true, title: 'TikTok Mwitu', statusBarStyle: 'black' },
};

export const viewport: Viewport = { themeColor: '#15121b', viewportFit: 'cover', interactiveWidget: 'resizes-content' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-KE"><head><link rel="stylesheet" href="/brand.css" /></head><body>{children}</body></html>;
}
