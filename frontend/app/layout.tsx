import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RouteMind",
  description:
    "An interactive route planner where AI agents plan the smartest driving route and explain every choice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
