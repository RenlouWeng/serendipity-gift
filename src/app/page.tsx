import { GiftTool } from "@/components/gift-tool";

const serendipityRules = [
  {
    title: "Relevant",
    body: "先跟客户的品牌、业务、岗位搭上关系，不然再贵也容易像乱送。",
  },
  {
    title: "Unexpected",
    body: "别一眼看上去就是目录货，客户才会觉得你真的有做功课。",
  },
  {
    title: "Novelty",
    body: "有点新鲜感，但又不至于太冒犯、太私人、太难解释。",
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
              不知道送什么时，
              <span className="font-serif italic text-[var(--accent-strong)]">
                先跑一版再决定
              </span>
              。
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--muted)] sm:text-base">
              广交会后、客户来访前、节日前，最怕的不是没礼物，是送得太普通、太重、太难批。你把手里有的客户信息贴进来，我先给你一版能推进的建议。
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
