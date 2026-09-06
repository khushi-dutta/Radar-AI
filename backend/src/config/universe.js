/**
 * A curated NSE universe: symbol -> display name + sector.
 *
 * Why a static list rather than a live lookup:
 *   1. Search-as-you-type must be instant and must not consume upstream quota.
 *      Local matching costs nothing and still works when upstream is down.
 *   2. Yahoo's sector field on Indian equities is inconsistent and often
 *      missing, but the divergence signal is only as good as its benchmark.
 *      A curated mapping is less impressive-sounding and far more correct.
 *
 * Symbols outside this list are still addable: they fall through to an upstream
 * symbol probe and default to the NIFTY 50 benchmark. This list is a fast path,
 * not a whitelist.
 */

export const SECTOR_INDICES = {
  BANK:   { index: '^NSEBANK',   label: 'Nifty Bank' },
  IT:     { index: '^CNXIT',     label: 'Nifty IT' },
  AUTO:   { index: '^CNXAUTO',   label: 'Nifty Auto' },
  PHARMA: { index: '^CNXPHARMA', label: 'Nifty Pharma' },
  FMCG:   { index: '^CNXFMCG',   label: 'Nifty FMCG' },
  METAL:  { index: '^CNXMETAL',  label: 'Nifty Metal' },
  ENERGY: { index: '^CNXENERGY', label: 'Nifty Energy' },
  REALTY: { index: '^CNXREALTY', label: 'Nifty Realty' },
  INFRA:  { index: '^CNXINFRA',  label: 'Nifty Infra' },
  BROAD:  { index: '^NSEI',      label: 'Nifty 50' },
};

export const DEFAULT_SECTOR = 'BROAD';

const RAW = [
  ['RELIANCE', 'Reliance Industries', 'ENERGY'],
  ['TCS', 'Tata Consultancy Services', 'IT'],
  ['HDFCBANK', 'HDFC Bank', 'BANK'],
  ['INFY', 'Infosys', 'IT'],
  ['ICICIBANK', 'ICICI Bank', 'BANK'],
  ['HINDUNILVR', 'Hindustan Unilever', 'FMCG'],
  ['ITC', 'ITC', 'FMCG'],
  ['SBIN', 'State Bank of India', 'BANK'],
  ['BHARTIARTL', 'Bharti Airtel', 'INFRA'],
  ['KOTAKBANK', 'Kotak Mahindra Bank', 'BANK'],
  ['LT', 'Larsen and Toubro', 'INFRA'],
  ['WIPRO', 'Wipro', 'IT'],
  ['AXISBANK', 'Axis Bank', 'BANK'],
  ['BAJFINANCE', 'Bajaj Finance', 'BANK'],
  ['TMPV', 'Tata Motors Passenger Vehicles', 'AUTO'],
  ['MARUTI', 'Maruti Suzuki India', 'AUTO'],
  ['SUNPHARMA', 'Sun Pharmaceutical Industries', 'PHARMA'],
  ['TITAN', 'Titan Company', 'FMCG'],
  ['ULTRACEMCO', 'UltraTech Cement', 'INFRA'],
  ['ADANIENT', 'Adani Enterprises', 'INFRA'],
  ['HCLTECH', 'HCL Technologies', 'IT'],
  ['TECHM', 'Tech Mahindra', 'IT'],
  ['LTTS', 'L and T Technology Services', 'IT'],
  ['INDUSINDBK', 'IndusInd Bank', 'BANK'],
  ['BANKBARODA', 'Bank of Baroda', 'BANK'],
  ['PNB', 'Punjab National Bank', 'BANK'],
  ['SBILIFE', 'SBI Life Insurance', 'BANK'],
  ['HDFCLIFE', 'HDFC Life Insurance', 'BANK'],
  ['BAJAJFINSV', 'Bajaj Finserv', 'BANK'],
  ['M&M', 'Mahindra and Mahindra', 'AUTO'],
  ['EICHERMOT', 'Eicher Motors', 'AUTO'],
  ['HEROMOTOCO', 'Hero MotoCorp', 'AUTO'],
  ['BAJAJ-AUTO', 'Bajaj Auto', 'AUTO'],
  ['TVSMOTOR', 'TVS Motor Company', 'AUTO'],
  ['ASHOKLEY', 'Ashok Leyland', 'AUTO'],
  ['CIPLA', 'Cipla', 'PHARMA'],
  ['DRREDDY', 'Dr Reddys Laboratories', 'PHARMA'],
  ['DIVISLAB', 'Divis Laboratories', 'PHARMA'],
  ['LUPIN', 'Lupin', 'PHARMA'],
  ['AUROPHARMA', 'Aurobindo Pharma', 'PHARMA'],
  ['TATASTEEL', 'Tata Steel', 'METAL'],
  ['JSWSTEEL', 'JSW Steel', 'METAL'],
  ['HINDALCO', 'Hindalco Industries', 'METAL'],
  ['VEDL', 'Vedanta', 'METAL'],
  ['COALINDIA', 'Coal India', 'ENERGY'],
  ['ONGC', 'Oil and Natural Gas Corporation', 'ENERGY'],
  ['NTPC', 'NTPC', 'ENERGY'],
  ['POWERGRID', 'Power Grid Corporation', 'ENERGY'],
  ['IOC', 'Indian Oil Corporation', 'ENERGY'],
  ['BPCL', 'Bharat Petroleum', 'ENERGY'],
  ['TATAPOWER', 'Tata Power', 'ENERGY'],
  ['NESTLEIND', 'Nestle India', 'FMCG'],
  ['BRITANNIA', 'Britannia Industries', 'FMCG'],
  ['DABUR', 'Dabur India', 'FMCG'],
  ['GODREJCP', 'Godrej Consumer Products', 'FMCG'],
  ['MARICO', 'Marico', 'FMCG'],
  ['DLF', 'DLF', 'REALTY'],
  ['GODREJPROP', 'Godrej Properties', 'REALTY'],
  ['OBEROIRLTY', 'Oberoi Realty', 'REALTY'],
  ['ADANIPORTS', 'Adani Ports and SEZ', 'INFRA'],
  ['GRASIM', 'Grasim Industries', 'INFRA'],
  ['SHREECEM', 'Shree Cement', 'INFRA'],
  ['ASIANPAINT', 'Asian Paints', 'FMCG'],
  ['PIDILITIND', 'Pidilite Industries', 'FMCG'],
  ['ETERNAL', 'Eternal (formerly Zomato)', 'BROAD'],
  ['PAYTM', 'One 97 Communications (Paytm)', 'BROAD'],
  ['NYKAA', 'FSN E-Commerce (Nykaa)', 'BROAD'],
  ['IRCTC', 'Indian Railway Catering and Tourism', 'BROAD'],
  ['IRFC', 'Indian Railway Finance Corporation', 'BROAD'],
  ['TRENT', 'Trent', 'BROAD'],
  ['JIOFIN', 'Jio Financial Services', 'BANK'],
  ['DMART', 'Avenue Supermarts (DMart)', 'FMCG'],
];

/** symbol (with .NS suffix) -> { symbol, base, name, sector } */
export const UNIVERSE = new Map(
  RAW.map(([base, name, sector]) => {
    const symbol = `${base}.NS`;
    return [symbol, { symbol, base, name, sector }];
  })
);

export function lookup(symbol) {
  return UNIVERSE.get(String(symbol).toUpperCase()) ?? null;
}

export function sectorFor(symbol) {
  return lookup(symbol)?.sector ?? DEFAULT_SECTOR;
}

export function benchmarkFor(symbol) {
  const sector = sectorFor(symbol);
  return SECTOR_INDICES[sector] ?? SECTOR_INDICES[DEFAULT_SECTOR];
}

/** Every index symbol the background worker must keep fresh. */
export function allIndexSymbols() {
  return [...new Set(Object.values(SECTOR_INDICES).map((s) => s.index))];
}

/**
 * Ranked search over the local universe.
 * Exact symbol > symbol prefix > name prefix > symbol substring > name substring.
 */
export function searchUniverse(query, limit = 8) {
  const q = String(query).trim().toUpperCase();
  if (!q) return [];
  const scored = [];
  for (const entry of UNIVERSE.values()) {
    const base = entry.base;
    const name = entry.name.toUpperCase();
    let score = null;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (base.includes(q)) score = 3;
    else if (name.includes(q)) score = 4;
    if (score !== null) scored.push({ score, entry });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.base.localeCompare(b.entry.base));
  return scored.slice(0, limit).map((s) => s.entry);
}
