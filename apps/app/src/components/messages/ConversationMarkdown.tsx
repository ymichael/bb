import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

interface ConversationMarkdownProps {
  content: string
  className?: string
}

export function ConversationMarkdown({ content, className }: ConversationMarkdownProps) {
  return (
    <div className={cn("max-w-none break-words text-sm leading-relaxed text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: codeClassName, children, ...props }: any) {
            const codeText = String(children ?? "").replace(/\n$/, "")
            const languageMatch = /language-(\w+)/.exec(codeClassName || "")
            const language = languageMatch?.[1]
            const isBlock = codeText.includes("\n")
            if (isBlock) {
              return (
                <pre className="my-2 overflow-x-auto rounded-md border border-border/70 bg-muted/35 p-3">
                  <code className={cn("font-mono ui-text-sm", language ? `language-${language}` : "")} {...props}>
                    {codeText}
                  </code>
                </pre>
              )
            }
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em]" {...props}>
                {children}
              </code>
            )
          },
          pre({ children }: any) {
            return <>{children}</>
          },
          p({ children }: any) {
            return <p className="mb-2 last:mb-0 text-foreground">{children}</p>
          },
          ul({ children }: any) {
            return <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>
          },
          ol({ children }: any) {
            return <ol className="mb-2 list-decimal pl-5 text-foreground">{children}</ol>
          },
          li({ children }: any) {
            return <li className="mb-1 text-foreground">{children}</li>
          },
          blockquote({ children }: any) {
            return (
              <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
                {children}
              </blockquote>
            )
          },
          table({ children }: any) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="min-w-full border border-border/80">{children}</table>
              </div>
            )
          },
          thead({ children }: any) {
            return <thead className="bg-muted/40">{children}</thead>
          },
          th({ children }: any) {
            return <th className="border border-border/80 px-2 py-1 text-left font-medium">{children}</th>
          },
          td({ children }: any) {
            return <td className="border border-border/80 px-2 py-1">{children}</td>
          },
          a({ children, href, ...props }: any) {
            return (
              <a
                href={href}
                className="underline underline-offset-2 break-all"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            )
          },
          hr() {
            return <hr className="my-4 border-t border-border/70" />
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
