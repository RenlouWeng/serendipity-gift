import { GiftTool } from "@/components/gift-tool";

const serendipityRules = [
  {
    title: "Relevant",
    body: "跟客户现在的品牌、业务、岗位角色有关系。不是你觉得好看，而是对方收到时会觉得这东西和我们有关。",
  },
  {
    title: "Unexpected",
    body: "不是钢笔、保温杯、茶叶这种所有人都在送的通用商务礼。要让客户觉得你不是从批发目录里随手翻的。",
  },
  {
    title: "Novelty",
    body: "对方之前大概率没收过，但一看就能理解你为什么送这个。不是猎奇，而是新鲜得刚刚好。",
  },
];

export default function Home() {
  return (
    <main className="relative overflow-hidden pb-20">
      <div className="mesh-orb mesh-orb-left" />
      <div className="mesh-orb mesh-orb-right" />

      <section className="section-shell pt-8 sm:pt-10">
        <div className="rounded-[32px] border border-black/10 bg-[rgba(255,251,245,0.78)] px-5 py-5 shadow-[var(--shadow)] sm:px-6">
          <div className="max-w-4xl">
            <p className="eyebrow">SERENDIPITY 送礼判断法</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.05em] sm:text-4xl">
              先判断这份礼物值不值得送，
              <span className="font-serif italic text-[var(--accent-strong)]">
                再决定送什么
              </span>
              。
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--muted)] sm:text-base">
              `Relevant` 是跟客户有关，`Unexpected` 是不像目录货，`Novelty` 是有点新鲜但不过火。下面直接贴客户信息，先跑第一版。
            </p>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {serendipityRules.map((item) => (
              <article
                key={item.title}
                className="rounded-[22px] border border-black/8 bg-white/76 p-4"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
                  {item.title}
                </p>
                <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                  {item.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section-shell mt-6">
        <GiftTool />
      </section>
    </main>
  );
}
