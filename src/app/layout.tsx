import type { Metadata, Viewport } from 'next';
import './globals.css';
import { COMANDAJA_LOGO } from '@/lib/logo';

export const metadata: Metadata = {
  title: 'ComandaJá',
  description:
    'Mesas, pedidos, cozinha, bar e balcão — ComandaJá para restaurantes.',
  icons: { icon: COMANDAJA_LOGO },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
