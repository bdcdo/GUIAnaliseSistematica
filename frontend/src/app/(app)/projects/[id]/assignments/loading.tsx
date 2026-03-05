export default function AssignmentsLoading() {
  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="h-6 w-32 animate-pulse rounded bg-muted" />
        <div className="h-10 w-28 animate-pulse rounded bg-muted" />
      </div>
      <div className="rounded-lg border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-8 border-b px-4 py-3">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
