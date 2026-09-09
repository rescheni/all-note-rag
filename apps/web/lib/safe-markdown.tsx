"use client";

import { Fragment, type ReactNode } from "react";
import { splitCiteMarks, type CiteRef } from "./cite-marks";

function inline(md: string, citations: CiteRef[] | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
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

function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  // | --- | :---: | ---: |
  return /^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(t) && /---/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && !isTableSep(t);
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/**
 * Safe markdown for ask answers: headings, lists, quotes, hr, code, GFM tables,
 * bold/italic/links. Optional 【n】 citation marks. No raw HTML.
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
    // GFM table: header row + separator, then body rows
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSep(lines[i + 1] ?? "")
    ) {
      const header = splitCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push(splitCells(lines[i] ?? ""));
        i += 1;
      }
      const tKey = key++;
      blocks.push(
        <div key={tKey} className="ask-md-table-wrap">
          <table className="ask-md-table">
            <thead>
              <tr>
                {header.map((cell, ci) => (
                  <th key={ci}>{inline(cell, citations, `th${tKey}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{inline(row[ci] ?? "", citations, `td${tKey}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
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
      while (
        i < lines.length &&
        (ordered ? /^\d+\.\s+/.test(lines[i] ?? "") : /^[-*]\s+/.test(lines[i] ?? ""))
      ) {
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
      !(lines[i] ?? "").startsWith("```") &&
      !(
        isTableRow(lines[i] ?? "") &&
        i + 1 < lines.length &&
        isTableSep(lines[i + 1] ?? "")
      ) &&
      !isTableRow(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    // orphan table-looking single lines: still as paragraph
    if (!para.length && isTableRow(line)) {
      para.push(line);
      i += 1;
    }
    if (!para.length) continue;
    const pKey = key++;
    blocks.push(<p key={pKey}>{inline(para.join(" "), citations, `p${pKey}`)}</p>);
  }
  return <div className="ask-md">{blocks}</div>;
}
