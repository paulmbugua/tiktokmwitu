
import type { Metadata } from 'next';
import './style.css';

export const metadata: Metadata = {
  title: 'Tiktok mwitu',
  description: 'Short videos from Kenyan creators. Watch, post and find your people.',
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-KE"><body>{children}</body></html>;
}
