
import type { Metadata, Viewport } from 'next';
import './style.css';
import './surfaces.css';

export const metadata: Metadata = {
  title: 'Tiktok mwitu',
  description: 'Short videos from Kenyan creators. Watch, post and find your people.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icons/favicon-32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: { url: '/icons/apple-touch-icon.png', sizes: '180x180' },
  },
  appleWebApp: { capable: true, title: 'Tiktok mwitu', statusBarStyle: 'black' },
};

export const viewport: Viewport = { themeColor: '#15121b', viewportFit: 'cover', interactiveWidget: 'resizes-content' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-KE"><body>{children}</body></html>;
}
