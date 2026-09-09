import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

function Svg({ children, className, ...rest }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

function Stroke({ d }: { d: string }) {
  return (
    <path
      d={d}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

export function IconChevron({ open = false }: { open?: boolean }) {
  return (
    <Svg className={open ? "twist open" : "twist"}>
      {/* Path mass centered on (8,8) so rotate(90deg) stays optically square in the 28px row */}
      <Stroke d="M5.5 3.5 L10.5 8 L5.5 12.5" />
    </Svg>
  );
}

export function IconNote() {
  return (
    <Svg>
      <Stroke d="M4.5 2.5 h5.5 L13 5.5 V13.5 H4.5 Z" />
      <Stroke d="M10 2.5 V5.5 H13" />
      <Stroke d="M6.5 8.5 h3" />
      <Stroke d="M6.5 11 h3" />
    </Svg>
  );
}

export function IconFolder() {
  return (
    <Svg>
      <Stroke d="M2.5 4.5 H6 l1.2 1.5 H13.5 V12.5 H2.5 Z" />
    </Svg>
  );
}

export function IconAsset() {
  return (
    <Svg>
      <Stroke d="M3 12.5 l3.2-3.2 2.1 2.1 2.4-3.4 L13 12.5" />
      <Stroke d="M3 3.5 H13 V12.5 H3 Z" />
      <Stroke d="M6 6.5 a0.8 0.8 0 1 0 0.01 0" />
    </Svg>
  );
}

export function IconCheck({ done }: { done: boolean }) {
  return (
    <Svg>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      {done ? <Stroke d="M5 8.2 L7.1 10.3 L11.2 5.7" /> : null}
    </Svg>
  );
}

export function IconSpace() {
  return (
    <Svg>
      <Stroke d="M2.5 13.5 V6.5 L8 2.5 l5.5 4 V13.5" />
      <Stroke d="M6.5 13.5 V9.5 H9.5 V13.5" />
    </Svg>
  );
}

export function IconNotes() {
  return (
    <Svg>
      <Stroke d="M4 2.5 H12 V13.5 H4 Z" />
      <Stroke d="M6.5 5.5 h3" />
      <Stroke d="M6.5 8.5 h3" />
      <Stroke d="M6.5 11.5 h2" />
    </Svg>
  );
}

export function IconSearch() {
  return (
    <Svg>
      <circle cx="7" cy="7" r="3.6" stroke="currentColor" strokeWidth="1.5" />
      <Stroke d="M10 10.2 L13.2 13.4" />
    </Svg>
  );
}

export function IconAsk() {
  return (
    <Svg>
      <Stroke d="M3 3.5 H13 V11 H6.5 L3.5 13.5 V11 H3 Z" />
    </Svg>
  );
}

export function IconGrowth() {
  return (
    <Svg>
      <Stroke d="M8 13.5 V6" />
      <Stroke d="M8 8.5 C8 8.5 5 8.5 5 5.5" />
      <Stroke d="M8 7 C8 7 11 7.2 11.2 4.2" />
      <Stroke d="M4 13.5 H12" />
    </Svg>
  );
}


export function IconMeetings() {
  return (
    <Svg>
      <Stroke d="M3 4.5 H13 V13.5 H3 Z" />
      <Stroke d="M3 7.5 H13" />
      <Stroke d="M6 2.5 V4.5" />
      <Stroke d="M10 2.5 V4.5" />
    </Svg>
  );
}

export function IconWriting() {
  return (
    <Svg>
      <Stroke d="M3.5 12.5 H6 L13 5.5 L10.5 3 L3.5 10 Z" />
      <Stroke d="M8.8 4.6 L11.4 7.2" />
    </Svg>
  );
}

export function IconSkills() {
  return (
    <Svg>
      <Stroke d="M8 2.5 L13.5 8 L8 13.5 L2.5 8 Z" />
    </Svg>
  );
}

export function IconConnect() {
  return (
    <Svg>
      <circle cx="4.6" cy="11.4" r="2.1" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.4" cy="4.6" r="2.1" stroke="currentColor" strokeWidth="1.5" />
      <Stroke d="M6.2 9.8 L9.8 6.2" />
    </Svg>
  );
}

export function IconMembers() {
  return (
    <Svg>
      <Stroke d="M8 7 a2 2 0 1 0 0-4 a2 2 0 0 0 0 4 Z" />
      <Stroke d="M3.5 13.5 C3.5 11 5.4 9.5 8 9.5 C10.6 9.5 12.5 11 12.5 13.5" />
    </Svg>
  );
}

export function IconAccount() {
  return (
    <Svg>
      <Stroke d="M8 7 a2.2 2.2 0 1 0 0-4.4 a2.2 2.2 0 0 0 0 4.4 Z" />
      <Stroke d="M3.2 13.5 C3.2 10.8 5.2 9.2 8 9.2 C10.8 9.2 12.8 10.8 12.8 13.5" />
      <Stroke d="M11.5 11.2 L13.2 12.9" />
    </Svg>
  );
}

export function IconLogout() {
  return (
    <Svg>
      <Stroke d="M6.5 3.5 H3.5 V12.5 H6.5" />
      <Stroke d="M7.5 8 H13" />
      <Stroke d="M10.5 5.5 L13 8 L10.5 10.5" />
    </Svg>
  );
}

export function IconLogin() {
  return (
    <Svg>
      <Stroke d="M9.5 3.5 H12.5 V12.5 H9.5" />
      <Stroke d="M3 8 H10.5" />
      <Stroke d="M8 5.5 L10.5 8 L8 10.5" />
    </Svg>
  );
}


export function IconAi() {
  return (
    <Svg>
      <Stroke d="M8 2.5 L9.2 6.2 L13 6.5 L10.2 9 L11 12.8 L8 10.8 L5 12.8 L5.8 9 L3 6.5 L6.8 6.2 Z" />
    </Svg>
  );
}

export function IconSettings() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.5" />
      <Stroke d="M8 2.4 V4.1" />
      <Stroke d="M8 11.9 V13.6" />
      <Stroke d="M2.4 8 H4.1" />
      <Stroke d="M11.9 8 H13.6" />
      <Stroke d="M3.9 3.9 L5.1 5.1" />
      <Stroke d="M10.9 10.9 L12.1 12.1" />
      <Stroke d="M12.1 3.9 L10.9 5.1" />
      <Stroke d="M5.1 10.9 L3.9 12.1" />
    </Svg>
  );
}

export function IconMenu() {
  return (
    <Svg>
      <Stroke d="M2.5 4.5 H13.5" />
      <Stroke d="M2.5 8 H13.5" />
      <Stroke d="M2.5 11.5 H13.5" />
    </Svg>
  );
}

export function IconClose() {
  return (
    <Svg>
      <Stroke d="M4 4 L12 12" />
      <Stroke d="M12 4 L4 12" />
    </Svg>
  );
}

/** Circular arrows — add `.icon-spin` via spinning for in-flight sync. */
export function IconSync({
  spinning = false,
  className,
}: {
  spinning?: boolean;
  className?: string;
}) {
  const cls = [spinning ? "icon-spin" : "", className].filter(Boolean).join(" ");
  return (
    <Svg className={cls || undefined}>
      <Stroke d="M3.2 8a4.8 4.8 0 0 1 8-3.4" />
      <Stroke d="M11.2 2.4 V5.2 H8.4" />
      <Stroke d="M12.8 8a4.8 4.8 0 0 1-8 3.4" />
      <Stroke d="M4.8 13.6 V10.8 H7.6" />
    </Svg>
  );
}

/**
 * Dedicated source marks — Feishu plane, Notion doc+N, SiYuan leaf/moss, Obsidian diamond.
 * Use className "source-mark" (plates/covers) or "note-source-mark" (note desk).
 */
export function IconSourceMark({
  source,
  className = "source-mark",
}: {
  source: string;
  className?: string;
}) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    className,
  };
  if (source === "obsidian") {
    return (
      <svg {...common}>
        <path d="M12 2.8 19.2 9.6 16.2 21.2 7.8 19.4 4.6 10.4Z" />
        <path d="M12 2.8 9.6 12.2l6.6 9" />
        <path d="M4.6 10.4 9.6 12.2" />
      </svg>
    );
  }
  if (source === "siyuan") {
    return (
      <svg {...common}>
        <path d="M12 3.2c2.7 2.8 4.2 5.1 4.2 7a4.2 4.2 0 0 1-8.4 0c0-1.9 1.5-4.2 4.2-7Z" />
        <path d="M6.2 17.2c2 1.15 3.9 1.15 5.8 0s3.9-1.15 5.8 0" />
        <path d="M6.2 20.3c2 1.15 3.9 1.15 5.8 0s3.9-1.15 5.8 0" />
      </svg>
    );
  }
  if (source === "notion") {
    return (
      <svg {...common}>
        <path d="M5.5 5h9L18.5 9v10h-13Z" />
        <path d="M14.5 5v4h4" />
        <path d="M8.5 15.5V11l5 4.5V11" />
      </svg>
    );
  }
  /* feishu + fallback: paper-plane */
  return (
    <svg {...common}>
      <path d="M4 12.5 20 4.5l-6 15-2.5-5.5Z" />
      <path d="m11.5 14 4-6" />
    </svg>
  );
}
