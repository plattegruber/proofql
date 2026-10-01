// The relevance floor, drawn where it acts: a hairline between the results
// a query returns and the candidates it dropped (scope.md §1 "Empty beats
// irrelevant"). Rendered even when one side is empty, so the floor is
// always visible as a number the Settings tab can change.
export function FloorLine({
  floor,
  above,
  below,
}: {
  floor: number;
  above: number;
  below: number;
}) {
  return (
    <div data-floor-line className="relative my-1 flex items-center gap-3">
      <span className="h-px flex-1 bg-ink-900" aria-hidden />
      <span className="font-mono text-label font-medium uppercase tracking-label text-ink-900">
        relevance floor · {floor.toFixed(2)}
      </span>
      <span className="font-mono text-label text-gray-500">
        {above} above · {below} below
      </span>
      <span className="h-px flex-1 bg-ink-900" aria-hidden />
    </div>
  );
}
