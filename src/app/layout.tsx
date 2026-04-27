import type { Metadata } from "next";
import { Cormorant_Garamond, Noto_Sans_SC } from "next/font/google";
import { siteConfig } from "@/lib/site";
import "./globals.css";

const notoSans = Noto_Sans_SC({
  variable: "--font-sans-cn",
  weight: ["400", "500", "700"],
  display: "swap",
  preload: false,
});

const cormorant = Cormorant_Garamond({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const metadataBase = (() => {
  try {
    return new URL(siteConfig.url);
  } catch {
    return new URL("https://example.com");
  }
})();

export const metadata: Metadata = {
  metadataBase,
  title: "Serendipity Gift | 外贸客户送礼建议工具",
  description:
    "输入公司名、官网、邮箱域名或社媒链接，自动生成礼物主推荐、采购执行卡和场景话术。",
  keywords: [
    "外贸送礼",
    "客户礼物推荐",
    "外贸业务员工具",
    "serendipity gift",
    "AI 礼物建议",
  ],
  openGraph: {
    title: "Serendipity Gift",
    description:
      "根据客户识别信息和公开页面，先帮外贸业务员定出主礼物、价格带、交期和寄送判断。",
    url: siteConfig.url,
    siteName: siteConfig.name,
    locale: "zh_CN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Serendipity Gift",
    description:
      "给外贸业务员用的轻量送礼工作台，先定主推荐，再给采购执行卡和场景话术。",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`${notoSans.variable} ${cormorant.variable}`}>
      <body>{children}</body>
    </html>
  );
}
