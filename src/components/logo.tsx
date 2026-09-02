import { cn } from "@/lib/cn";

/** Geometric xAI-adjacent mark — shard / folded A. */
export function GrokMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-7", className)} aria-hidden>
      <path
        d="M12 2.4L3.6 21h3.3l1.55-3.5h7.1L17.1 21h3.3L12 2.4zm0 6.2l2.55 5.7H9.45L12 8.6z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-full bg-ink text-paper">
        <GrokMark className="size-3.5" />
      </span>
      <div className="leading-none">
        <div className="text-[17px] font-medium tracking-tight text-ink">
          Grok <span className="font-normal text-mute">Design</span>
        </div>
        {!compact && (
          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">xAI Labs</div>
        )}
      </div>
    </div>
  );
}
