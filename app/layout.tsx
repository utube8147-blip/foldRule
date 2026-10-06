import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { MotionProvider } from '@/components/MotionProvider';
import { PwaProvider } from '@/components/pwa/PwaProvider';
import { ConfirmProvider } from '@/components/common/ConfirmDialog';
import { BRAND } from '@/lib/brand';

// Fonts are self-hosted (app/fonts/*.woff2, variable fonts from Fontsource), so
// the build never depends on reaching Google Fonts and the installed app has
// its fonts offline. Inter (UI) + JetBrains Mono (labels, values).
const inter = localFont({
  src: [
    { path: './fonts/inter-latin-wght-normal.woff2',     weight: '100 900', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  variable: '--font-jetbrains',
  display: 'swap',
});

// Archivo (width + weight axes) is used only for the Foldrule wordmark.
const archivo = localFont({
  src: './fonts/archivo-latin-wdth-normal.woff2',
  weight: '100 900',
  variable: '--font-archivo',
  display: 'swap',
  declarations: [{ prop: 'font-stretch', value: '62% 125%' }],
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
        <MotionProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </MotionProvider>
        <PwaProvider />
      </body>
    </html>
  );
}
