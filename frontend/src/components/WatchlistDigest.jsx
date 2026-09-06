import React, { useMemo } from 'react';
import { Sparkles, Clock } from 'lucide-react';
import { sectorLabel } from '../utils/formatters.js';

function generateAiNarrative(data) {
  const { items, avgDayChange } = data;
  if (!items || items.length === 0) return "Not enough data to generate an insight.";

  const significant = items.filter(i => i.significance.significant);
  if (significant.length === 0) {
    return "The market is exceptionally quiet today. No stocks on your watchlist are showing significant breakouts, volume anomalies, or structural changes since your last check.";
  }

  // Find dominant sector
  const sectorCount = {};
  for (const item of significant) {
    if (item.sector) {
      sectorCount[item.sector] = (sectorCount[item.sector] || 0) + 1;
    }
  }
  const sortedSectors = Object.entries(sectorCount).sort((a, b) => b[1] - a[1]);
  const dominantSector = sortedSectors.length > 0 ? sectorLabel(sortedSectors[0][0]) : null;

  const breakout = significant.find(i => i.significance.reasons?.[0]?.key === 'breakout');
  const volume = significant.find(i => i.significance.reasons?.[0]?.key === 'volume');
  
  let narrative = `Market sentiment leans ${avgDayChange >= 0 ? 'bullish' : 'bearish'} overall, with your tracked stocks ${avgDayChange >= 0 ? 'up' : 'down'} ${Math.abs(avgDayChange || 0)}% on average. `;

  if (dominantSector && sortedSectors[0][1] > 1) {
    narrative += `The ${dominantSector} sector is driving most of the action. `;
  }

  if (breakout) {
    narrative += `${breakout.symbol.replace('.NS', '')} is breaking out decisively, `;
  } else if (volume) {
    narrative += `${volume.symbol.replace('.NS', '')} is seeing massive unusual volume, `;
  } else {
    narrative += `${significant[0].symbol.replace('.NS', '')} tops the radar with notable signals, `;
  }

  const quiet = data.quietStocks?.[0];
  if (quiet) {
    narrative += `while ${quiet.replace('.NS', '')} remains unusually dormant and may be coiling for a move.`;
  } else if (significant.length > 1) {
    narrative += `and ${significant.length - 1} other tracked equities require your attention.`;
  } else {
    narrative += `with no other major anomalies detected.`;
  }

  return narrative;
}

export default function WatchlistDigest({ data, sincePhrase }) {
  if (!data || !data.items || data.items.length === 0) return null;

  const narrative = useMemo(() => generateAiNarrative(data), [data]);

  return (
    <div className="card border border-[#8B5CF6]/30 overflow-hidden bg-gradient-to-br from-surface to-[#8B5CF6]/5 relative">
      <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
        <Sparkles size={64} className="text-high" />
      </div>
      
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-high font-medium">
          <Sparkles size={16} className="text-high animate-pulse" />
          <h2 className="text-sm tracking-wide">Radar AI Insight</h2>
          {sincePhrase && (
            <div className="flex items-center gap-1 ml-auto text-xs text-muted/70 font-normal border border-border/50 rounded-full px-2 py-0.5 bg-surface2/50">
              <Clock size={10} />
              <span>{sincePhrase}</span>
            </div>
          )}
        </div>
        
        <p className="text-sm text-txt/90 leading-relaxed font-medium relative z-10">
          {narrative}
        </p>
      </div>
    </div>
  );
}
