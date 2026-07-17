import type { Metadata, Viewport } from 'next';
import { Analytics } from "@vercel/analytics/next"
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'digital logic simulator',
    'logic gate simulator',
    'logic circuit simulator',
    'online circuit simulator',
    'circuit design',
    'boolean logic',
    'truth table generator',
    'timing diagram',
    'flip-flop simulator',
    'VHDL simulator',
    'FPGA',
    'digital electronics',
  ],
  category: 'education',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // lock page zoom so iOS doesn't auto-zoom on input focus — the canvas
  // has its own pinch-zoom
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#131316',
};

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  description: SITE_DESCRIPTION,
  applicationCategory: 'EducationalApplication',
  operatingSystem: 'Any',
  browserRequirements: 'Requires JavaScript and a modern web browser.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  featureList: [
    'Logic gates (AND, OR, NOT, NAND, NOR, XOR, XNOR) with multi-bit buses',
    'Memory circuits: latches, flip-flops, and shift registers',
    'VHDL module editor with live compilation',
    'Truth table and state machine analysis',
    'Timing diagrams and test vectors',
    'Reusable custom chips and a community chip library',
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
      <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2632420782943202"></script>
      </head>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
