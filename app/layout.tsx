import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Archivo } from 'next/font/google';
import './globals.css';
import { MotionProvider } from '@/components/MotionProvider';
import { BRAND } from '@/lib/brand';

// App typography (unchanged from the original design): Inter + JetBrains Mono.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

// Archivo is used only for the Foldrule wordmark (the logo).
const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  axes: ['wdth'],
  display: 'swap',
});

const defaultTitle = `${BRAND.name} — ${BRAND.tagline}`;

export const metadata: Metadata = {
  metadataBase: new URL(BRAND.siteUrl),
  title: {
    default:  defaultTitle,
    template: `%s – ${BRAND.name}`,
  },
  description:     BRAND.description,
  applicationName: BRAND.name,
  keywords:        [...BRAND.keywords],
  category:        'business',
  creator:         BRAND.name,
  formatDetection: { telephone: false, address: false, email: false },
  openGraph: {
    type:        'website',
    siteName:    BRAND.name,
    title:       defaultTitle,
    description: BRAND.description,
    url:         '/',
    locale:      'en_GB',
  },
  twitter: {
    card:        'summary_large_image',
    title:       defaultTitle,
    description: BRAND.description,
  },
  robots: { index: true, follow: true },
  appleWebApp: { capable: true, title: BRAND.name, statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor:  BRAND.colors.graphite,
  colorScheme: 'dark',
  width:       'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`bg-industrial-black ${inter.variable} ${jetbrainsMono.variable} ${archivo.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased font-sans">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
