import React, { useMemo } from 'react';
import Chart from 'react-apexcharts';
import { formatPct, sectorLabel } from '../utils/formatters.js';

export default function HeatmapView({ items, onOpen }) {
  if (!items || items.length === 0) return null;

  const validItems = items.filter(i => !i.unavailable && i.dayChangePct !== null);

  const getHexColor = (pct) => {
    if (pct > 2) return '#059669'; 
    if (pct > 0) return '#34d399'; 
    if (pct === 0) return '#6b7280'; 
    if (pct > -2) return '#f87171'; 
    return '#dc2626'; 
  };

  // Group by sector
  const series = useMemo(() => {
    const groups = {};
    for (const item of validItems) {
      const sec = item.sector ? sectorLabel(item.sector) : 'Other';
      if (!groups[sec]) groups[sec] = [];
      groups[sec].push({
        x: item.symbol.replace('.NS', ''),
        y: item.volume || 1000, 
        fillColor: getHexColor(item.dayChangePct),
        meta: {
          changePct: item.dayChangePct,
          originalItem: item
        }
      });
    }
    return Object.entries(groups).map(([name, data]) => ({ name, data }));
  }, [validItems]);

  const options = {
    legend: { show: false },
    chart: {
      type: 'treemap',
      toolbar: { show: false },
      background: 'transparent',
      events: {
        dataPointSelection: (event, chartContext, config) => {
          const { seriesIndex, dataPointIndex } = config;
          if (seriesIndex !== undefined && dataPointIndex !== undefined) {
            const dp = series[seriesIndex].data[dataPointIndex];
            if (dp) onOpen(dp.meta.originalItem);
          }
        }
      }
    },
    title: {
      text: 'Market Heatmap (Sized by Volume)',
      style: { color: '#9ca3af' }
    },
    dataLabels: {
      enabled: true,
      style: {
        fontSize: '12px',
        fontWeight: 'bold',
      },
      formatter: function(text, op) {
        const dp = series[op.seriesIndex].data[op.dataPointIndex];
        return [text, formatPct(dp.meta.changePct)];
      }
    },
    plotOptions: {
      treemap: {
        enableShades: false,
      }
    },
    tooltip: {
      theme: 'dark',
      y: {
        formatter: function (value, { seriesIndex, dataPointIndex }) {
          const dp = series[seriesIndex].data[dataPointIndex];
          return `Volume: ${value?.toLocaleString()} | Change: ${formatPct(dp.meta.changePct)}`;
        }
      }
    }
  };

  return (
    <div className="card p-2 bg-surface/50">
      <Chart
        options={options}
        series={series}
        type="treemap"
        height={500}
      />
    </div>
  );
}
