/**
 * A 30-session close sparkline. Pure SVG: no chart library for one polyline,
 * and no runtime cost beyond the path string.
 */
export default function Sparkline({ points, positive, width = 92, height = 28 }) {
  if (!points || points.length < 2) {
    return <div style={{ width, height }} aria-hidden="true" />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);

  const coords = points.map((p, i) => [i * step, height - ((p - min) / span) * (height - 4) - 2]);
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const stroke = positive ? '#3FB950' : '#F85149';
  const id = `spark-${Math.round(points[0] * 1000)}-${points.length}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      role="img"
      aria-label={`30-session trend, ${positive ? 'up' : 'down'} overall`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={coords.at(-1)[0]} cy={coords.at(-1)[1]} r="2" fill={stroke} />
    </svg>
  );
}
