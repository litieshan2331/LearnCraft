/**
 * 节点知识内容阅读组件。
 *
 * 组件与函数：
 * - CardContentView：展示 foundation、worked_example、pitfalls_debug 和来源引用。
 *
 * 示例区块（多文件目录树 + 高亮 + 调用顺序）由 worked-example-view.tsx 渲染；
 * 纯文本渲染复用 content-text.tsx 的 ContentText。
 */

import { BookOpenText, ExternalLink, Lightbulb } from "lucide-react";

import type { CardContent } from "../api/content-client";
import { ContentText } from "./content-text";
import { WorkedExampleView } from "./worked-example-view";

export function CardContentView({ content }: Readonly<{ content: CardContent }>) {
  return (
    <section className="mt-8 border-t border-border pt-8">
      <div className="flex items-center gap-2 text-primary">
        <BookOpenText aria-hidden className="size-4" />
        <p className="text-xs tracking-[0.16em]">NODE CONTENT · V{content.version}</p>
      </div>

      <article className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
        <h2 className="font-heading text-2xl font-medium">核心概念</h2>
        <ContentText className="mt-4 text-sm leading-8 text-muted-foreground" value={content.foundation} />
      </article>

      <article className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
        <h2 className="font-heading text-2xl font-medium">示例：从输入到结果</h2>
        <WorkedExampleView workedExample={content.worked_example} />
      </article>

      <article className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
        <h2 className="inline-flex items-center gap-2 font-heading text-2xl font-medium"><Lightbulb aria-hidden className="size-5 text-primary" />常见误区与排错</h2>
        <div className="mt-4 grid gap-4">
          {content.pitfalls_debug.map((pitfall, index) => (
            <article className="rounded-2xl border border-border/80 bg-background/65 p-4" key={`${pitfall.title}-${index}`}>
              <h3 className="font-medium">{pitfall.title}</h3>
              <p className="mt-3 text-sm leading-7 text-muted-foreground"><strong className="text-foreground">原因：</strong>{pitfall.cause}</p>
              <p className="mt-2 text-sm leading-7 text-muted-foreground"><strong className="text-foreground">修复：</strong>{pitfall.fix}</p>
            </article>
          ))}
        </div>
      </article>

      {content.source_refs.length > 0 ? (
        <article className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
          <h2 className="font-heading text-2xl font-medium">参考来源</h2>
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

