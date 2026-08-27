/**
 * MoneyCard — the envelope-soft surface (FRONTEND_PLAN §5: cards r20, warm paper
 * with depth, not flat panels). Subtle CSS lift on hover ("paper that reacts like
 * paper"); the heavier 3D-tilt/cursor-glow (§5b) is layered on later where it earns
 * its cost. Server-safe. Never a flat dark card grid — that anti-pattern is banned.
 */
import { cn } from "@/lib/utils";

export function MoneyCard({
  children,
  className,
  interactive = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** enable the hover lift (for clickable cards). */
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-[20px] border border-line bg-surface p-6",
        "shadow-[0_1px_2px_rgba(30,27,34,0.04),0_8px_24px_-12px_rgba(30,27,34,0.10)]",
        interactive &&
          "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(30,27,34,0.05),0_16px_32px_-16px_rgba(30,27,34,0.16)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
