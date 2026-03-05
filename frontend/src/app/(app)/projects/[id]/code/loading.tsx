export default function CodeLoading() {
  return (
    <div className="flex h-[calc(100vh-7rem)]">
      <div className="w-72 border-r p-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 w-full animate-pulse rounded bg-muted" />
        ))}
      </div>
      <div className="flex-1 p-6 space-y-4">
        <div className="h-6 w-64 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
