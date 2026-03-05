export default function DocumentsLoading() {
  return (
    <div className="p-6">
      <div className="mb-6 h-10 w-48 animate-pulse rounded bg-muted" />
      <div className="mb-4 flex items-center gap-4">
        <div className="h-10 w-80 animate-pulse rounded bg-muted" />
        <div className="h-4 w-16 animate-pulse rounded bg-muted" />
      </div>
      <div className="rounded-lg border">
        <div className="border-b bg-muted/50 px-4 py-2">
          <div className="flex gap-8">
            <div className="h-4 w-12 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          </div>
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex gap-8 border-b px-4 py-3">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="h-5 w-8 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
