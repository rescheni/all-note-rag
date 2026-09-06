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
