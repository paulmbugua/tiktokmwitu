import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { manifest: null, appleWebApp: null };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
