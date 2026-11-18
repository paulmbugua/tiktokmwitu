import type { Metadata } from 'next';
import Moderation from './moderation';

export const metadata: Metadata = {
  title: 'Moderation | Tiktok mwitu',
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <Moderation />;
}
