import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api.js';

/**
 * Debounced search with keyboard navigation.
 *
 * Two details that matter: the request is debounced AND aborted, so a fast
 * typist never has an older response overwrite a newer one; and the existing
 * watchlist is passed in so already-added symbols are labelled rather than
 * offered and then rejected by the server.
 */
export default function AddStockSearch({ onAdd, existingSymbols = [], busy }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);

  const boxRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      abortRef.current?.abort();
      return undefined;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      // Cancel the previous request so out-of-order responses cannot win.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await api.search(q, controller.signal);
        setResults(res.results ?? []);
        setCursor(0);
        setOpen(true);
        setError(null);
      } catch (err) {
        if (err.name !== 'AbortError') setError(err);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 220);

    return () => clearTimeout(timer);
  }, [query]);

  // Close on outside click.
  useEffect(() => {
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const existing = new Set(existingSymbols);

  const choose = async (result) => {
    if (existing.has(result.symbol)) return;
    setQuery('');
    setResults([]);
    setOpen(false);
    await onAdd(result.symbol);
  };

  const onKeyDown = (e) => {
    if (!open || !results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[cursor]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <input
          className="input pl-9"
          placeholder="Add a stock — try RELIANCE or Infosys"
          value={query}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="Search stocks to add"
          aria-expanded={open}
          role="combobox"
          aria-controls="search-results"
        />
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true">
          🔍
        </span>
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">…</span>
        )}
      </div>

      {open && (
        <ul
          id="search-results"
          role="listbox"
          className="absolute z-20 mt-1.5 w-full card overflow-hidden max-h-72 overflow-y-auto"
        >
          {results.length === 0 && !searching && (
            <li className="px-3 py-3 text-sm text-muted">
              No matches for “{query}”. Try an NSE symbol like TCS.
            </li>
          )}
          {results.map((r, i) => {
            const already = existing.has(r.symbol);
            return (
              <li key={r.symbol}>
                <button
                  role="option"
                  aria-selected={i === cursor}
                  disabled={already}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(r)}
                  className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-3
                    ${i === cursor ? 'bg-surface2' : ''} ${already ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface2'}`}
                >
                  <span className="min-w-0">
                    <span className="font-medium">{r.symbol.replace('.NS', '')}</span>
                    <span className="block text-xs text-muted truncate">{r.name}</span>
                  </span>
                  <span className="text-xs text-muted shrink-0">
                    {already ? 'Added' : r.source === 'upstream' ? 'Found ↗' : '+'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="mt-1.5 text-xs text-loss">{error.message}</p>}
    </div>
  );
}
