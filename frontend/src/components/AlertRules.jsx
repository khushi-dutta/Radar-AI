import React, { useState, useEffect } from 'react';
import { api } from '../services/api.js';
import { timeAgo } from '../utils/formatters.js';
import { Sparkles, ArrowRight } from 'lucide-react';

export default function AlertRules() {
  const [alerts, setAlerts] = useState([]);
  const [symbol, setSymbol] = useState('');
  const [ruleType, setRuleType] = useState('volume_spike');
  const [threshold, setThreshold] = useState('2.0');
  
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiError, setAiError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    try {
      const res = await api.getAlerts();
      setAlerts(res.alerts);
    } catch (e) {
      console.error(e);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!symbol) return;
    setBusy(true);
    try {
      await api.addAlert({ symbol: symbol.toUpperCase(), ruleType, threshold: parseFloat(threshold) });
      setSymbol('');
      loadAlerts();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const handleAskAI = async (e) => {
    e.preventDefault();
    if (!aiPrompt.trim()) return;
    setBusy(true);
    setAiError('');
    
    // Simulate AI parsing delay
    await new Promise(r => setTimeout(r, 600));

    let parsed = null;
    const text = aiPrompt.toLowerCase();
    
    // Simple heuristic parser for the demo
    const volMatch = text.match(/([a-z]+).*volume.*(\d+(?:\.\d+)?)x/i);
    if (volMatch) {
      parsed = { symbol: volMatch[1].toUpperCase(), ruleType: 'volume_spike', threshold: parseFloat(volMatch[2]) };
    }
    
    const proxMatch = text.match(/([a-z]+).*within (\d+(?:\.\d+)?)%.*high/i);
    if (!parsed && proxMatch) {
      parsed = { symbol: proxMatch[1].toUpperCase(), ruleType: 'price_proximity', threshold: parseFloat(proxMatch[2]) / 100 };
    }

    if (parsed) {
      try {
        await api.addAlert(parsed);
        setAiPrompt('');
        loadAlerts();
      } catch (e) {
        setAiError('Failed to save the parsed alert.');
      }
    } else {
      setAiError("I couldn't understand that. Try 'Alert me when RELIANCE volume is 2x' or 'TCS within 5% of high'.");
    }
    setBusy(false);
  };

  const handleDelete = async (id) => {
    try {
      await api.deleteAlert(id);
      loadAlerts();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleAskAI} className="card overflow-hidden bg-surface relative">
        <div className="absolute top-0 right-0 p-3 opacity-10 pointer-events-none">
          <Sparkles size={48} className="text-high" />
        </div>
        <div className="p-4 bg-high/5">
          <div className="flex items-center gap-2 text-high font-semibold mb-3">
            <Sparkles size={16} className="text-high" />
            <h3>Ask Radar AI to set an alert</h3>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. 'Alert me when HDFCBANK volume is 3x'"
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              className="input bg-bg border-high/30 focus:border-high/60 focus:ring-high/20 placeholder:text-muted/60 flex-1 relative z-10"
              disabled={busy}
            />
            <button type="submit" disabled={busy || !aiPrompt.trim()} className="btn-primary bg-high text-bg hover:bg-high/90 border border-high/20 shadow-sm relative z-10 w-12 flex justify-center">
              <ArrowRight size={18} />
            </button>
          </div>
          {aiError && <p className="text-loss text-xs mt-2">{aiError}</p>}
        </div>
      </form>

      <form onSubmit={handleAdd} className="card p-4 space-y-3 bg-surface2/50 border border-border/50">
        <h3 className="font-semibold text-txt/80 text-sm">Or add manually</h3>
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="text"
            placeholder="Symbol (e.g. RELIANCE)"
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            className="input bg-bg border-border text-sm flex-1 min-w-[120px]"
            required
          />
          <select 
            value={ruleType} 
            onChange={e => setRuleType(e.target.value)}
            className="input bg-bg border-border text-sm flex-1 min-w-[120px]"
          >
            <option value="volume_spike">Volume Spike (x times avg)</option>
            <option value="price_proximity">Price Proximity to 52w High (pct)</option>
          </select>
          <input
            type="number"
            step="0.01"
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            className="input bg-bg border-border text-sm w-24"
            required
          />
          <button type="submit" disabled={busy} className="btn-ghost text-sm px-4 border border-border">Add</button>
        </div>
      </form>

      <div className="space-y-2 pt-2">
        {alerts.length === 0 && <p className="text-muted text-sm text-center py-4">No alerts configured.</p>}
        {alerts.map(a => (
          <div key={a.id} className="card p-3 flex justify-between items-center border border-border/50">
            <div>
              <div className="font-medium text-sm">
                {a.symbol} - {a.rule_type === 'volume_spike' ? 'Volume > ' + a.threshold + 'x' : 'Within ' + (a.threshold * 100).toFixed(1) + '% of 52w high'}
              </div>
              {a.last_triggered_at && (
                <div className="text-xs text-muted mt-0.5">Last triggered: {timeAgo(a.last_triggered_at)}</div>
              )}
            </div>
            <button onClick={() => handleDelete(a.id)} className="btn-ghost hover:text-loss hover:bg-loss/10 text-xs px-2 border border-border/30 rounded">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
