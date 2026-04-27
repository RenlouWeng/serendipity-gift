# Serendipity Gift

一个部署在 Vercel 上的轻量外贸送礼工作台。用户输入公司名、官网、邮箱域名、LinkedIn 或其他客户识别信息，再补送礼场景、预算、收礼人角色和地区，系统会先给出 `1 个主推荐 + 2 个备选`，并附带采购执行卡和可复制的场景沟通话术。

## Features

- 低输入门槛：公司名、官网、邮箱域名、LinkedIn 任填一个就能开始
- 工作台导向：首屏优先处理输入、角色、地区、场景和预算，不再把工具做成重介绍页
- 决策导向：不是并列 3 个建议，而是 `1 个主推荐 + 2 个备选`
- 服务端抓取：优先分析官网和可公开访问的页面；没有链接时也能按手动输入先给保守版本
- AI 结果：输出客户判断、判断把握度、缺失线索、关键线索、主推荐、两个备选、采购执行字段和场景话术
- 私域承接：结果后弱引导联系方式 CTA，并可转发复制/CTA 事件到 webhook
- 正式上线导向：生产环境只使用云端环境变量管理 AI 配置，不依赖本地开发机配置

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS 4
- Serverless Route Handlers，适合直接部署到 Vercel

## Local Setup

1. 安装依赖

```bash
npm install
```

2. 创建环境变量

```bash
cp .env.example .env.local
```

3. 最少建议配置

```bash
OPENAI_API_KEY=your_key
OPENAI_BASE_URL=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_CONTACT_HANDLE=your_wechat_or_contact
```

4. 启动本地开发

```bash
npm run dev
```

打开 `http://localhost:3000`。

## Environment Variables

- `OPENAI_API_KEY`: OpenAI API key。生产环境必须配置。
- `OPENAI_BASE_URL`: 可选。用于 OpenAI 兼容网关。
- `OPENAI_MODEL`: 默认 `gpt-4.1-mini`
- `OPENAI_REASONING_EFFORT`: 可选。对 `gpt-5` 系列可设为 `low` / `medium` / `high`
- `NEXT_PUBLIC_SITE_URL`: 站点 URL，用于 metadata / sitemap / robots
- `NEXT_PUBLIC_CONTACT_HANDLE`: 结果页 CTA 展示并复制的联系方式
- `LEAD_WEBHOOK_URL`: 可选。配置后，`/api/lead` 会把 CTA 事件转发到你的 webhook

## Production Setup

建议使用下面这套最轻量的正式上线方式：

1. 代码托管到 GitHub
2. 通过 Vercel 直接连接仓库并自动部署
3. 在 Vercel Project Settings 里配置环境变量
4. 所有敏感信息只放在 Vercel 环境变量中，不写入仓库

生产环境至少配置：

```bash
OPENAI_API_KEY=your_key
NEXT_PUBLIC_SITE_URL=https://your-domain.com
NEXT_PUBLIC_CONTACT_HANDLE=your_wechat_or_contact
```

如果没有配置 `OPENAI_API_KEY`，接口会直接返回错误，不会再依赖本地机器配置。

## API

### `POST /api/analyze`

请求体：

```json
{
  "customer_input": "Patagonia\npatagonia.com\nbuyer@patagonia.com",
  "occasion": "trade_show_follow_up",
  "budget_tier": "300_800_cny",
  "recipient_role": "采购 / Buyer",
  "target_region": "United States",
  "note": "展会后想一周内寄出，礼物别太重。"
}
```

响应体：

```json
{
  "customer_summary": "string",
  "decision_summary": "string",
  "analysis_confidence": "high",
  "analysis_gaps": ["string"],
  "evidence_highlights": ["string"],
  "recipient_role": "采购 / Buyer",
  "target_region": "United States",
  "primary_recommendation": {
    "name": "string",
    "item_type": "string",
    "reason": "string",
    "why_now": "string",
    "budget_fit": "string",
    "target_unit_price": "string",
    "lead_time": "string",
    "customization_level": "string",
    "shipping_ease": "string",
    "sourcing_tip": "string",
    "approval_hint": "string",
    "caution": "string",
    "message_snippet": "string"
  },
  "backup_recommendations": [
    {
      "name": "string",
      "item_type": "string",
      "reason": "string",
      "why_now": "string",
      "budget_fit": "string",
      "target_unit_price": "string",
      "lead_time": "string",
      "customization_level": "string",
      "shipping_ease": "string",
      "sourcing_tip": "string",
      "approval_hint": "string",
      "caution": "string",
      "message_snippet": "string"
    }
  ],
  "follow_up_message": "string",
  "risk_notes": ["string"],
  "source_summary": [
    {
      "url": "string",
      "label": "string",
      "status": "used",
      "evidence": "string"
    }
  ],
  "cta_message": "string",
  "mode": "ai"
}
```

### `POST /api/lead`

用于记录 CTA 点击事件。默认只写入运行日志；配置 `LEAD_WEBHOOK_URL` 后会自动转发。

## Deploy

直接导入到 Vercel 即可。确保把上面的环境变量同步到 Vercel Project Settings。

建议上线前至少检查：

- 已配置 `OPENAI_API_KEY`
- 已配置正式域名对应的 `NEXT_PUBLIC_SITE_URL`
- 已配置 `NEXT_PUBLIC_CONTACT_HANDLE`
- 已确认 `/api/analyze` 的频率限制符合当前流量预期
