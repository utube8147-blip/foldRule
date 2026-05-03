import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en" className="bg-[#0A0A0A]">
      <body className="antialiased">{children}</body>
    </html>
  );
}
