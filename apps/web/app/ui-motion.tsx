"use client";

import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  type HTMLMotionProps,
} from "motion/react";
import Link from "next/link";
import {
  type ButtonHTMLAttributes,
  type MouseEvent,
  useCallback,
} from "react";

export const springSoft = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.55 };
export const springSnap = { type: "spring" as const, stiffness: 520, damping: 36, mass: 0.42 };
export const easeOutExpo = [0.16, 1, 0.3, 1] as const;

export { AnimatePresence, LayoutGroup, motion, useReducedMotion };

export const MotionLink = motion.create(Link);

export function SignatureButton({
  className = "",
  children,
  onMouseMove,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const reduced = useReducedMotion();
  const mx = useMotionValue(72);
  const my = useMotionValue(40);
  const gx = useSpring(mx, { stiffness: 170, damping: 22, mass: 0.35 });
  const gy = useSpring(my, { stiffness: 170, damping: 22, mass: 0.35 });
  const glare = useMotionTemplate`radial-gradient(130px 70px at ${gx}% ${gy}%, rgba(255,250,242,0.4), transparent 64%)`;

  const handleMove = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      onMouseMove?.(e);
      if (reduced) return;
      const r = e.currentTarget.getBoundingClientRect();
      mx.set(((e.clientX - r.left) / Math.max(r.width, 1)) * 100);
      my.set(((e.clientY - r.top) / Math.max(r.height, 1)) * 100);
    },
    [mx, my, onMouseMove, reduced],
  );

  return (
    <motion.button
      className={["signature", className].filter(Boolean).join(" ")}
      onMouseMove={handleMove}
      whileHover={reduced || rest.disabled ? undefined : { y: -1 }}
      whileTap={reduced || rest.disabled ? undefined : { scale: 0.97 }}
      transition={springSnap}
      {...(rest as HTMLMotionProps<"button">)}
    >
      {!reduced && <motion.span className="btn-glare" style={{ background: glare }} aria-hidden="true" />}
      <span className="btn-label">{children}</span>
    </motion.button>
  );
}

export function SourcePills({
  items,
  active,
}: {
  items: readonly { id: string; label: string }[];
  active: string;
}) {
  return (
    <LayoutGroup id="source-pills">
      <div className="source-picker">
        {items.map((s) => {
          const on = active === s.id;
          return (
            <Link key={s.id} href={`/connections/new?source=${s.id}`} className={on ? "active" : ""}>
              {on && <motion.span className="pill-wash" layoutId="source-pill" transition={springSoft} />}
              <span>{s.label}</span>
            </Link>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
