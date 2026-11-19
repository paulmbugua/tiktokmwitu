import type { Metadata } from 'next';
import Moderation from './moderation';

export const metadata: Metadata = {
  title: 'Moderation | TikTok Mwitu',
  description: 'TikTok Mwitu moderation dashboard.',
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <Moderation />;
}
