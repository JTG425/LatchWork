import type { Metadata, Viewport } from 'next';
import { Analytics } from "@vercel/analytics/next"
import './globals.css';

export const metadata: Metadata = {
  title: 'Latchwork — digital logic workbench',
  description:
    'Design and simulate digital logic circuits in the browser: gates, switches, LEDs, live wiring, and reusable custom chips.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#131316',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head> 
      <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2632420782943202"></script>
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
