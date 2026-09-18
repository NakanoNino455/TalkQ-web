import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { Check, Copy } from "lucide-react";
import { cn, copyText } from "@/lib/utils";

/** Only a curated language set is bundled, so the build stays small. */
const LANGUAGES: Record<string, unknown> = {
  bash,
  sh: bash,
  shell: bash,
  css,
  go,
  java,
  javascript,
  js: javascript,
  json,
  jsx,
  markdown,
  md: markdown,
  markup,
  html: markup,
  xml: markup,
  python,
  py: python,
  rust,
  rs: rust,
  sql,
  tsx,
  typescript,
  ts: typescript,
  yaml,
  yml: yaml,
};

const REGISTERED = new Set(Object.keys(LANGUAGES));
for (const [name, definition] of Object.entries(LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, definition as never);
}

/** Fenced code block with the required Copy button. */
export function CodeBlock({ language, value }: { language?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const label = (language || "text").toLowerCase();

  const handleCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-[hsl(220_40%_7%)]">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/25 px-3 py-1.5">
        <span className="text-meta uppercase tracking-[0.16em] text-muted-foreground">
          {label === "text" ? "code" : label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors",
            copied ? "text-success" : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {REGISTERED.has(label) ? (
        <SyntaxHighlighter
          language={label}
          style={oneDark}
          customStyle={{
            margin: 0,
            background: "transparent",
            padding: "0.85rem 0.95rem",
            fontSize: "12px",
            lineHeight: "1.65",
          }}
          codeTagProps={{ style: { fontFamily: "inherit", background: "transparent" } }}
        >
          {value}
        </SyntaxHighlighter>
      ) : (
        <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12px] leading-relaxed text-foreground/90">
          <code>{value}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Streaming-friendly Markdown renderer: GFM (tables, task lists, strikethrough),
 * headings, lists, links, inline code and code blocks with a Copy button.
 */
export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("nexq-prose", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Unwrap <pre> — CodeBlock renders its own container.
          pre: ({ children }) => <>{children}</>,
          code: ({ className: codeClassName, children, ...rest }) => {
            const match = /language-([\w-]+)/.exec(codeClassName ?? "");
            const text = String(children ?? "").replace(/\n$/, "");
            const isBlock = Boolean(match) || text.includes("\n");
            if (isBlock) return <CodeBlock language={match?.[1]} value={text} />;
            return (
              <code className={codeClassName} {...rest}>
                {children}
              </code>
            );
          },
          a: ({ children, ...rest }) => (
            <a {...rest} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
