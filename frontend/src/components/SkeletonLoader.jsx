/**
 * Skeletons, not spinners: they preserve layout so the page does not jump when
 * data lands, and they communicate the shape of what is coming.
 */
function Shimmer({ className = '' }) {
  return (
    <div className={`relative overflow-hidden rounded bg-surface2 ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <Shimmer className="h-4 w-24" />
          <Shimmer className="h-3 w-36" />
        </div>
        <div className="space-y-2 text-right">
          <Shimmer className="h-4 w-20 ml-auto" />
          <Shimmer className="h-3 w-14 ml-auto" />
        </div>
      </div>
      <Shimmer className="mt-3 h-6 w-2/3" />
    </div>
  );
}

export default function SkeletonLoader({ count = 4 }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading watchlist">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}
