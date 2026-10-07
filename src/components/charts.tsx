// Server-rendered charts: plain HTML/CSS, single-hue blue, hover/focus tooltips,
// and a table fallback so no number is locked inside a color.

type Bar = { label: string; value: number; tooltip: string; tick?: string };

export function BarChart({ title, bars, format }: { title: string; bars: Bar[]; format: (n: number) => string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const peak = bars.reduce((best, b) => (b.value > best.value ? b : best), bars[0]);
  return (
    <figure className="card">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="h2">{title}</span>
        {peak && peak.value > 0 && (
          <span className="text-xs text-ink-2">
            Peak: {peak.label} · {format(peak.value)}
          </span>
        )}
      </figcaption>
      <div className="mt-4 flex h-40 items-end gap-[2px] border-b border-line" role="img" aria-label={title}>
        {bars.map((b) => (
          <div key={b.label} className="group relative flex h-full flex-1 items-end" tabIndex={0}>
            <div
              className="w-full rounded-t-[4px] bg-viz opacity-90 group-hover:opacity-100 group-focus:opacity-100"
              style={{ height: `${(b.value / max) * 100}%`, minHeight: b.value > 0 ? 2 : 0 }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-xs text-bg shadow group-hover:block group-focus:block">
              {b.tooltip}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-ink-3">
        {bars.map((b) => (
          <div key={b.label} className="flex-1 truncate text-center">
            {b.tick ?? ""}
          </div>
        ))}
      </div>
      <TableToggle headers={["", "Value"]} rows={bars.map((b) => [b.label, format(b.value)])} />
    </figure>
  );
}

export function Heatmap({
  title,
  rows,
  cols,
  values,
  unit,
}: {
  title: string;
  rows: string[];
  cols: string[];
  values: number[][];
  unit: string;
}) {
  const max = Math.max(1, ...values.flat());
  return (
    <figure className="card">
      <figcaption className="h2">{title}</figcaption>
      <div className="mt-4 overflow-x-auto">
        <div
          className="grid min-w-[520px] gap-[2px]"
          style={{ gridTemplateColumns: `2.5rem repeat(${cols.length}, minmax(0, 1fr))` }}
          role="img"
          aria-label={title}
        >
          <div />
          {cols.map((c) => (
            <div key={c} className="text-center text-[10px] text-ink-3">
              {c}
            </div>
          ))}
          {rows.map((r, ri) => (
            <div key={r} className="contents">
              <div className="pr-1 text-right text-xs leading-7 text-ink-2">{r}</div>
              {cols.map((c, ci) => {
                const v = values[ri][ci];
                const pct = v === 0 ? 0 : 15 + Math.round((v / max) * 85);
                return (
                  <div
                    key={c}
                    tabIndex={0}
                    className="group relative h-7 rounded-[4px]"
                    style={{ background: `color-mix(in oklab, var(--viz-max) ${pct}%, var(--viz-0))` }}
                  >
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-xs text-bg shadow group-hover:block group-focus:block">
                      {r} {c}: {v} {unit}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-2">
        <span>Fewer</span>
        <span
          className="h-2 w-24 rounded-full"
          style={{ background: "linear-gradient(to right, var(--viz-0), var(--viz-max))" }}
          aria-hidden
        />
        <span>More {unit}</span>
      </div>
      <TableToggle
        headers={["", ...cols]}
        rows={rows.map((r, ri) => [r, ...values[ri].map(String)])}
      />
    </figure>
  );
}

function TableToggle({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-ink-2">Show as table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full tabular-nums">
          <thead>
            <tr className="text-left text-ink-2">
              {headers.map((h, i) => (
                <th key={i} className="px-1 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => (
                  <td key={j} className="px-1 py-1">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
