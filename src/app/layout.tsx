import type { Metadata } from "next";
import CasesProvider from "@/components/CasesProvider";
import TopBar from "@/components/TopBar";
import { Suspense } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rebuttal",
  description: "An AI agent that defends small sellers in PayPal disputes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <CasesProvider>
          {/* The tabs read the URL, which Next.js resolves per request. */}
          <Suspense fallback={<header className="h-[53px] border-b border-line bg-panel" />}>
            <TopBar />
          </Suspense>
          <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-5 sm:px-4 sm:py-6">{children}</main>
        </CasesProvider>
      </body>
    </html>
  );
}
