import React, { useState, useEffect } from 'react';
import { api } from '../services/api.js';
import { timeAgo } from '../utils/formatters.js';

export default function ActivityLog() {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    api.getActivity().then(res => setLogs(res.logs)).catch(() => {});
  }, []);

  return (
    <div className="space-y-3">
      {logs.length === 0 ? (
        <p className="text-muted text-sm text-center py-4">No activity yet.</p>
      ) : (
        logs.map(log => (
          <div key={log.id} className="card p-3 flex flex-col gap-1">
            <div className="flex justify-between items-start">
              <span className="font-medium text-sm text-txt">
                {log.symbol ? log.symbol + ': ' : ''}{log.message}
              </span>
              <span className="text-xs text-muted whitespace-nowrap ml-2">
                {timeAgo(log.created_at)}
              </span>
            </div>
            <span className="text-[10px] text-muted uppercase tracking-wider bg-surface2 self-start px-1.5 rounded">
              {log.event_type.replace('_', ' ')}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
