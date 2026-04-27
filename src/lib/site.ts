export const siteConfig = {
  name: "Serendipity Gift",
  description:
    "输入公司名、官网、邮箱域名或社媒链接，自动生成礼物主推荐、采购执行卡和当前场景沟通话术。",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.com").replace(
    /\/$/,
    "",
  ),
  contactHandle: process.env.NEXT_PUBLIC_CONTACT_HANDLE ?? "serendipity-gift",
};
