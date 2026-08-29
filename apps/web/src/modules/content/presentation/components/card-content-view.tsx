/**
 * 节点知识内容阅读组件。
 *
 * 组件与函数：
 * - CardContentView：展示 foundation、worked_example、pitfalls_debug 和来源引用。
 * - ContentText：以保留换行的纯文本方式展示模型生成内容。
 */

import { BookOpenText, ExternalLink, Lightbulb, ListChecks } from "lucide-react";

import type { CardContent } from "../api/content-client";

export function CardContentView({ content }: Readonly<{ content: CardContent }>) {
  return (
    <section className="mt-8 border-t border-border pt-8">
      <div className="flex items-center gap-2 text-primary">
        <BookOpenText aria-hidden className="size-4" />
        <p className="text-xs tracking-[0.16em]">NODE CONTENT · V{content.version}</p>
      </div>

      <article className="mt-5 border border-border bg-card p-5 sm:p-7">
        <h2 className="font-heading text-2xl font-normal">核心概念</h2>
        <ContentText className="mt-4 text-sm leading-8 text-muted-foreground" value={content.foundation} />
      </article>

      <article className="mt-5 border border-border bg-card p-5 sm:p-7">
        <h2 className="font-heading text-2xl font-normal">示例：从输入到结果</h2>
        <ContentText className="mt-4 text-sm leading-8 text-muted-foreground" value={content.worked_example.explanation} />
        <pre className="mt-5 overflow-x-auto border border-border bg-[#1e201b] p-4 font-mono text-sm leading-6 text-[#f4f1e8]"><code>{content.worked_example.code}</code></pre>
        <div className="mt-5 grid gap-5 border-t border-border pt-5 sm:grid-cols-2">
          <div>
            <p className="inline-flex items-center gap-2 text-xs tracking-[0.14em] text-primary"><ListChecks aria-hidden className="size-4" />调用顺序</p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-7">
              {content.worked_example.call_sequence.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
          <div>
            <p className="text-xs tracking-[0.14em] text-primary">预期输出</p>
            <ContentText className="mt-3 text-sm leading-7 text-muted-foreground" value={content.worked_example.expected_output} />
          </div>
        </div>
      </article>

      <article className="mt-5 border border-border bg-card p-5 sm:p-7">
        <h2 className="inline-flex items-center gap-2 font-heading text-2xl font-normal"><Lightbulb aria-hidden className="size-5 text-primary" />常见误区与排错</h2>
        <ContentText className="mt-4 text-sm leading-8 text-muted-foreground" value={content.pitfalls_debug} />
      </article>

      {content.source_refs.length > 0 ? (
        <article className="mt-5 border border-border bg-card p-5 sm:p-7">
          <h2 className="font-heading text-2xl font-normal">参考来源</h2>
          <ul className="mt-4 grid gap-3">
            {content.source_refs.map((source, index) => {
              const title = typeof source.title === "string" ? source.title : "参考来源 " + String(index + 1);
              const url = typeof source.url === "string" ? source.url : null;
              return (
                <li className="text-sm" key={(url ?? title) + "-" + String(index)}>
                  {url ? (
                    <a className="inline-flex items-center gap-2 text-primary underline-offset-4 hover:underline" href={url} rel="noreferrer" target="_blank">
                      {title}<ExternalLink aria-hidden className="size-3" />
                    </a>
                  ) : <span className="text-muted-foreground">{title}</span>}
                </li>
              );
            })}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function ContentText({ value, className }: Readonly<{ value: string; className?: string }>) {
  return (
    <p className={className}>
      {value.split("\n").map((line, index) => <span key={String(index) + "-" + line}>{index > 0 ? <br /> : null}{line}</span>)}
    </p>
  );
}
