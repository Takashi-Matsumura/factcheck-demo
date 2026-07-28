export function RunTimeline({
  steps,
  running,
}: {
  steps: string[];
  running: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <ol className="space-y-1.5 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/60">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <li key={i} className="flex items-start gap-2 text-zinc-600 dark:text-zinc-400">
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600" />
            <span className={isLast && running ? "animate-pulse" : ""}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
