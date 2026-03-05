export default function StatsLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-4">
            <div className="mb-2 h-4 w-20 animate-pulse rounded bg-muted" />
            <div className="h-8 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="h-6 w-48 animate-pulse rounded bg-muted" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />
        ))}
      </div>
      <div className="h-6 w-48 animate-pulse rounded bg-muted" />
      <div className="h-80 w-full animate-pulse rounded bg-muted" />
    </div>
  );
}
