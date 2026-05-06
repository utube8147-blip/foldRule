import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Quantity Savior - Professional Estimation Suite",
  description: "Industrial-grade precision for modern estimators. Auto-count, auto-scale, and export to Excel in seconds.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html 
      lang="en" 
      className={`bg-[#0A0A0A] ${inter.variable} ${jetbrainsMono.variable}`} 
      suppressHydrationWarning
    >
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
