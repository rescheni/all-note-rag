"use client";

import { Fragment, type ReactNode } from "react";
import { splitCiteMarks, type CiteRef } from "./cite-marks";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(md: string, citations: CiteRef[] | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // code `…`, **bold**, *em*, [label](url), plain (may contain 【n】)
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\)|[^*`\[]+)/g;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const chunk = m[0];
    const key = `${keyBase}-${i++}`;
    if (chunk.startsWith("`") && chunk.endsWith("`")) {
      out.push(<code key={key}>{chunk.slice(1, -1)}</code>);
    } else if (chunk.startsWith("**") && chunk.endsWith("**")) {
      out.push(<strong key={key}>{inline(chunk.slice(2, -2), citations, key)}</strong>);
    } else if (chunk.startsWith("*") && chunk.endsWith("*")) {
      out.push(<em key={key}>{inline(chunk.slice(1, -1), citations, key)}</em>);
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const href = m[3].trim();
      const safe =
        /^(https?:\/\/|\/|#|mailto:)/i.test(href) && !/^(javascript:|data:)/i.test(href)
          ? href
          : "#";
      out.push(
        <a key={key} href={safe} rel="noopener noreferrer">
          {m[2]}
        </a>,
      );
    } else {
      const parts = splitCiteMarks(chunk, citations, key);
      if (parts.length === 1 && typeof parts[0] === "string") {
        out.push(<Fragment key={key}>{parts[0]}</Fragment>);
      } else {
        out.push(
          <Fragment key={key}>
            {parts.map((p, pi) =>
              typeof p === "string" ? <Fragment key={`${key}-t${pi}`}>{p}</Fragment> : p,
            )}
          </Fragment>,
        );
      }
    }
  }
  return out;
}

/**
 * Small safe markdown subset for ask answers: headings, lists, quotes, hr, bold/italic/code/links.
 * Optional citations turn 【n】 into interactive superscripts.
 * No raw HTML.
 */
export function SafeMarkdown({
  source,
  citations,
}: {
  source: string;
  citations?: CiteRef[];
}) {
  const lines = (source || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={key++} />);
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const body = inline(heading[2], citations, `h${key}`);
      if (level === 1) blocks.push(<h1 key={key++}>{body}</h1>);
      else if (level === 2) blocks.push(<h2 key={key++}>{body}</h2>);
      else blocks.push(<h3 key={key++}>{body}</h3>);
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      const qKey = key++;
      blocks.push(
        <blockquote key={qKey}>
          {quote.map((q, qi) => (
            <p key={qi}>{inline(q, citations, `q${qKey}-${qi}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+\.\s+/.test(lines[i] ?? "") : /^[-*]\s+/.test(lines[i] ?? ""))) {
        items.push((lines[i] ?? "").replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ""));
        i += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      const lKey = key++;
      blocks.push(
        <ListTag key={lKey}>
          {items.map((it, ii) => (
            <li key={ii}>{inline(it, citations, `l${lKey}-${ii}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }
    if (line.startsWith("```")) {
      const fence: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        fence.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre key={key++}>
          <code>{fence.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,3})\s+/.test(lines[i] ?? "") &&
      !/^>\s?/.test(lines[i] ?? "") &&
      !/^[-*]\s+/.test(lines[i] ?? "") &&
      !/^\d+\.\s+/.test(lines[i] ?? "") &&
      !/^---+$/.test((lines[i] ?? "").trim()) &&
      !(lines[i] ?? "").startsWith("```")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    const pKey = key++;
    blocks.push(<p key={pKey}>{inline(para.join(" "), citations, `p${pKey}`)}</p>);
  }
  return <div className="ask-md">{blocks}</div>;
}

void escapeHtml;
