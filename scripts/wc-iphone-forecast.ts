#!/usr/bin/env bun
/**
 * wc-iphone-forecast — Fetch WooCommerce orders from the last 3 months,
 * identify iPhone sales by model and color, and forecast next month.
 *
 * Usage:
 *   WC_KEY=ck_... WC_SECRET=cs_... WC_URL=https://myshop.com \
 *     bun run scripts/wc-iphone-forecast.ts
 *
 *   Or via CLI args:
 *     bun run scripts/wc-iphone-forecast.ts --key ck_... --secret cs_... --url https://...
 *
 *   Credentials can also live in a .env file at the project root (Bun auto-loads it).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface WCMetaData {
  key: string;
  value: string;
}

interface WCLineItem {
  name: string;
  quantity: number;
  meta_data: WCMetaData[];
}

interface WCOrder {
  id: number;
  date_created: string;
  line_items: WCLineItem[];
}

interface ForecastEntry {
  model: string;
  color: string;
  feb: number;
  mar: number;
  apr: number;
  aprScaled: number;
  forecastMay: number;
}

// month → model → color → total units
type SalesMap = Map<string, Map<string, Map<string, number>>>;

// ─── Credentials ─────────────────────────────────────────────────────────────

function getCredentials(): { key: string; secret: string; url: string } {
  const args = process.argv.slice(2);
  let key = '';
  let secret = '';
  let url = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key'    && args[i + 1]) key    = args[++i];
    if (args[i] === '--secret' && args[i + 1]) secret = args[++i];
    if (args[i] === '--url'    && args[i + 1]) url    = args[++i];
  }

  key    = key    || process.env.WC_KEY    || '';
  secret = secret || process.env.WC_SECRET || '';
  url    = url    || process.env.WC_URL    || '';

  if (!key || !secret || !url) {
    console.error('ERROR: Missing WooCommerce credentials.');
    console.error('');
    console.error('Set environment variables:');
    console.error('  WC_KEY=ck_...  WC_SECRET=cs_...  WC_URL=https://myshop.com');
    console.error('');
    console.error('Or pass CLI args:');
    console.error('  --key ck_...  --secret cs_...  --url https://myshop.com');
    process.exit(1);
  }

  return { key, secret, url: url.replace(/\/$/, '') };
}

// ─── WooCommerce Fetch ────────────────────────────────────────────────────────

async function fetchAllOrders(
  baseUrl: string,
  key: string,
  secret: string,
  after: string,
): Promise<WCOrder[]> {
  const all: WCOrder[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      consumer_key:    key,
      consumer_secret: secret,
      per_page:        '100',
      page:            String(page),
      after,
      status:          'completed,processing,on-hold',
      orderby:         'date',
      order:           'asc',
    });

    const endpoint = `${baseUrl}/wp-json/wc/v3/orders?${params}`;
    process.stderr.write(`  Fetching page ${page}...\n`);

    let res: Response;
    try {
      res = await fetch(endpoint);
    } catch (err) {
      console.error(`\nNetwork error on page ${page}: ${err}`);
      console.error('Check that the store URL is reachable and your internet connection is up.');
      process.exit(1);
    }

    if (!res.ok) {
      console.error(`\nHTTP ${res.status} ${res.statusText} on page ${page}`);
      if (res.status === 401) {
        console.error('Check WC_KEY and WC_SECRET — authentication failed.');
      } else if (res.status === 403) {
        console.error('Check REST API permissions in WooCommerce > Settings > Advanced > REST API.');
      }
      process.exit(1);
    }

    const orders: WCOrder[] = await res.json();
    if (orders.length === 0) break;

    all.push(...orders);
    page++;
  }

  return all;
}

// ─── Model Extraction ─────────────────────────────────────────────────────────

function normalizeModelSuffix(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(pro|max|plus|mini|se)\b/gi, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function extractModel(name: string): string | null {
  // Pass 1: explicit "iPhone" keyword — longest variant matched first
  const pass1 = name.match(
    /\biPhone\s+(SE|\d{2}\s*(?:Pro\s*Max|Pro(?!\s*Max)|Plus|Mini)?)/i,
  );
  if (pass1) {
    return 'iPhone ' + normalizeModelSuffix(pass1[1]);
  }

  // Pass 2: product name starts with model number (no "iPhone" keyword)
  const pass2 = name.match(
    /^(?:Apple\s+)?(\d{2}\s+(?:Pro\s*Max|Pro|Plus|Mini)|\d{2})\b/i,
  );
  if (pass2) {
    return 'iPhone ' + normalizeModelSuffix(pass2[1]);
  }

  return null;
}

// ─── Color Extraction ─────────────────────────────────────────────────────────

const COLOR_META_KEYS = ['pa_color', 'attribute_pa_color', 'color', 'pa_colour', 'pa_chroma'];

function normalizeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isStorage(s: string): boolean {
  return /^\d+\s*(?:GB|TB|MB)\b/i.test(s.trim());
}

function extractColor(item: WCLineItem): string {
  // Priority 1: structured meta_data
  for (const meta of item.meta_data) {
    if (COLOR_META_KEYS.some(k => k.toLowerCase() === meta.key.toLowerCase())) {
      const v = meta.value.trim();
      if (v) return normalizeName(v);
    }
  }

  // Priority 2: parenthetical suffix — "iPhone 15 (Blue, 128GB)"
  const parenMatch = item.name.match(/\(([^)]+)\)/);
  if (parenMatch) {
    for (const part of parenMatch[1].split(',')) {
      const candidate = part.trim();
      if (candidate && !isStorage(candidate)) return normalizeName(candidate);
    }
  }

  // Priority 3: dash/hyphen suffix — "iPhone 16 - Titanium Black"
  const dashMatch = item.name.match(/[-–]\s*(.+?)(?:\s*\(|$)/);
  if (dashMatch) {
    const candidate = dashMatch[1].trim();
    if (candidate.length > 2 && !isStorage(candidate)) return normalizeName(candidate);
  }

  return 'Unknown';
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function bucketMonth(dateCreated: string): string {
  return dateCreated.slice(0, 7); // "2026-03T..." → "2026-03"
}

function aggregateSales(orders: WCOrder[]): SalesMap {
  const map: SalesMap = new Map();

  for (const order of orders) {
    const month = bucketMonth(order.date_created);

    for (const item of order.line_items) {
      const nameHasIPhone = /iphone/i.test(item.name);
      const pass2Match    = /^(?:Apple\s+)?(\d{2}\s+(?:Pro\s*Max|Pro|Plus|Mini)|\d{2})\b/i.test(item.name);

      if (!nameHasIPhone && !pass2Match) continue;

      const model = extractModel(item.name);
      if (!model) continue;

      const color = extractColor(item);
      const qty   = Math.max(0, item.quantity);
      if (qty === 0) continue;

      if (!map.has(month)) map.set(month, new Map());
      const byModel = map.get(month)!;
      if (!byModel.has(model)) byModel.set(model, new Map());
      const byColor = byModel.get(model)!;
      byColor.set(color, (byColor.get(color) ?? 0) + qty);
    }
  }

  return map;
}

// ─── Forecast ────────────────────────────────────────────────────────────────

const MONTHS      = ['2026-02', '2026-03', '2026-04'] as const;
const WEIGHTS     = { '2026-02': 1, '2026-03': 2, '2026-04': 3 } as const;
const APR_SCALE   = 30 / 28; // April: 28 of 30 days elapsed as of today

function computeForecast(sales: SalesMap): ForecastEntry[] {
  const combos = new Set<string>();
  for (const [, byModel] of sales) {
    for (const [model, byColor] of byModel) {
      for (const [color] of byColor) {
        combos.add(`${model}\x00${color}`);
      }
    }
  }

  const results: ForecastEntry[] = [];

  for (const combo of combos) {
    const [model, color] = combo.split('\x00');

    const get = (month: string) => sales.get(month)?.get(model)?.get(color) ?? 0;

    const feb       = get('2026-02');
    const mar       = get('2026-03');
    const apr       = get('2026-04');
    const aprScaled = apr * APR_SCALE;

    const weightedSum = feb * WEIGHTS['2026-02'] + mar * WEIGHTS['2026-03'] + aprScaled * WEIGHTS['2026-04'];
    const forecastMay = Math.round(weightedSum / 6);

    results.push({ model, color, feb, mar, apr, aprScaled, forecastMay });
  }

  results.sort(
    (a, b) =>
      b.forecastMay - a.forecastMay ||
      a.model.localeCompare(b.model) ||
      a.color.localeCompare(b.color),
  );

  return results;
}

// ─── Output ──────────────────────────────────────────────────────────────────

const W = { model: 22, color: 20, num: 6 };

function col(s: string, w: number, right = false): string {
  const truncated = s.length > w ? s.slice(0, w - 1) + '…' : s;
  return right ? truncated.padStart(w) : truncated.padEnd(w);
}

function separator(total: number): string {
  return '─'.repeat(total);
}

function printMonthlyBreakdown(sales: SalesMap): void {
  console.log('\nMonthly Breakdown — iPhone Sales');
  const width = W.model + 2 + W.color + 2 + W.num * 4 + 6;
  console.log('═'.repeat(width));

  const header =
    col('Model', W.model) + '  ' +
    col('Color', W.color) + '  ' +
    col('Feb', W.num, true) + '  ' +
    col('Mar', W.num, true) + '  ' +
    col('Apr', W.num, true) + '  ' +
    col('Total', W.num, true);
  console.log(header);
  console.log(separator(width));

  // Collect all (model, color) combinations
  const allCombos: Array<{ model: string; color: string }> = [];
  const seen = new Set<string>();
  for (const month of MONTHS) {
    const byModel = sales.get(month);
    if (!byModel) continue;
    for (const [model, byColor] of byModel) {
      for (const [color] of byColor) {
        const key = `${model}\x00${color}`;
        if (!seen.has(key)) {
          seen.add(key);
          allCombos.push({ model, color });
        }
      }
    }
  }

  // Sort by 3-month total desc
  allCombos.sort((a, b) => {
    const totalA = MONTHS.reduce((s, m) => s + (sales.get(m)?.get(a.model)?.get(a.color) ?? 0), 0);
    const totalB = MONTHS.reduce((s, m) => s + (sales.get(m)?.get(b.model)?.get(b.color) ?? 0), 0);
    return totalB - totalA || a.model.localeCompare(b.model) || a.color.localeCompare(b.color);
  });

  let totFeb = 0, totMar = 0, totApr = 0;

  for (const { model, color } of allCombos) {
    const feb = sales.get('2026-02')?.get(model)?.get(color) ?? 0;
    const mar = sales.get('2026-03')?.get(model)?.get(color) ?? 0;
    const apr = sales.get('2026-04')?.get(model)?.get(color) ?? 0;
    const total = feb + mar + apr;
    totFeb += feb; totMar += mar; totApr += apr;

    console.log(
      col(model, W.model) + '  ' +
      col(color, W.color) + '  ' +
      col(feb   ? String(feb)   : '-', W.num, true) + '  ' +
      col(mar   ? String(mar)   : '-', W.num, true) + '  ' +
      col(apr   ? String(apr)   : '-', W.num, true) + '  ' +
      col(String(total), W.num, true),
    );
  }

  const grandTotal = totFeb + totMar + totApr;
  console.log(separator(width));
  console.log(
    col('TOTAL', W.model) + '  ' +
    col('', W.color) + '  ' +
    col(String(totFeb), W.num, true) + '  ' +
    col(String(totMar), W.num, true) + '  ' +
    col(String(totApr), W.num, true) + '  ' +
    col(String(grandTotal), W.num, true),
  );
}

function printModelSummary(sales: SalesMap): void {
  console.log('\nModel Summary — 3-Month Totals');
  console.log('═'.repeat(40));

  const totals = new Map<string, number>();
  for (const [, byModel] of sales) {
    for (const [model, byColor] of byModel) {
      for (const [, qty] of byColor) {
        totals.set(model, (totals.get(model) ?? 0) + qty);
      }
    }
  }

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  for (const [model, total] of sorted) {
    const dots = '.'.repeat(Math.max(2, 36 - model.length));
    console.log(`${model} ${dots} ${String(total).padStart(4)} units`);
  }
}

function printForecast(entries: ForecastEntry[]): void {
  console.log('\nMay 2026 Forecast');
  console.log('(Apr scaled ×30/28 to full month  |  weights: Feb×1  Mar×2  Apr×3)');
  const width = W.model + 2 + W.color + 2 + W.num + 2 + W.num + 2 + W.num + 2 + 14;
  console.log('═'.repeat(width));

  console.log(
    col('Model', W.model) + '  ' +
    col('Color', W.color) + '  ' +
    col('Feb', W.num, true) + '  ' +
    col('Mar', W.num, true) + '  ' +
    col('Apr raw', W.num + 2, true) + '  ' +
    col('May fcst', 10, true),
  );
  console.log(separator(width));

  for (const e of entries) {
    console.log(
      col(e.model, W.model) + '  ' +
      col(e.color, W.color) + '  ' +
      col(e.feb ? String(e.feb) : '-', W.num, true) + '  ' +
      col(e.mar ? String(e.mar) : '-', W.num, true) + '  ' +
      col(e.apr ? String(e.apr) : '-', W.num + 2, true) + '  ' +
      col(String(e.forecastMay), 10, true),
    );
  }

  console.log(separator(width));
  const totalForecast = entries.reduce((s, e) => s + e.forecastMay, 0);
  console.log(
    col('TOTAL', W.model) + '  ' +
    col('', W.color) + '  ' +
    col('', W.num) + '  ' +
    col('', W.num) + '  ' +
    col('', W.num + 2) + '  ' +
    col(String(totalForecast), 10, true),
  );
}

function printTopRankings(sales: SalesMap, forecast: ForecastEntry[]): void {
  console.log('\nTop Rankings — May 2026 Forecast');
  console.log('═'.repeat(60));

  // Aggregate forecast by model and color
  const byModel = new Map<string, number>();
  const byColor = new Map<string, number>();
  for (const e of forecast) {
    byModel.set(e.model, (byModel.get(e.model) ?? 0) + e.forecastMay);
    byColor.set(e.color, (byColor.get(e.color) ?? 0) + e.forecastMay);
  }

  const topModels = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topColors = [...byColor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const modelHeader = col('Top 3 Models', 30);
  const colorHeader = col('Top 3 Colors', 28);
  console.log(`${modelHeader}  ${colorHeader}`);
  console.log(`${'─'.repeat(30)}  ${'─'.repeat(28)}`);

  const rows = Math.max(topModels.length, topColors.length);
  for (let i = 0; i < rows; i++) {
    const mEntry = topModels[i];
    const cEntry = topColors[i];
    const mStr = mEntry
      ? `${i + 1}. ${col(mEntry[0], 22)} ${String(mEntry[1]).padStart(3)} u`
      : '';
    const cStr = cEntry
      ? `${i + 1}. ${col(cEntry[0], 20)} ${String(cEntry[1]).padStart(3)} u`
      : '';
    console.log(`${col(mStr, 30)}  ${cStr}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { key, secret, url } = getCredentials();

  // 3 months back from April 28, 2026
  const AFTER_DATE = '2026-01-28T00:00:00';

  console.log('WooCommerce iPhone Forecast');
  console.log('═'.repeat(50));
  console.log(`Store : ${url}`);
  console.log(`Period: ${AFTER_DATE.slice(0, 10)} → 2026-04-28`);
  console.log(`Orders: completed + processing + on-hold (excludes cancelled/refunded)`);
  console.log(`Target: May 2026 forecast\n`);
  console.log('Fetching orders...');

  const orders = await fetchAllOrders(url, key, secret, AFTER_DATE);
  process.stderr.write('\n');

  console.log(`Fetched ${orders.length} orders total.\n`);

  if (orders.length === 0) {
    console.log('No orders found in this period. Nothing to forecast.');
    process.exit(0);
  }

  const sales    = aggregateSales(orders);
  const forecast = computeForecast(sales);

  const iphoneOrders = forecast.reduce((s, e) => s + e.feb + e.mar + e.apr, 0);
  if (iphoneOrders === 0) {
    console.log('No iPhone line items found in the fetched orders.');
    console.log('Check that product names contain "iPhone" or start with a model number like "16 Pro Max".');
    process.exit(0);
  }

  printMonthlyBreakdown(sales);
  printModelSummary(sales);
  printForecast(forecast);
  printTopRankings(sales, forecast);

  console.log('\n');
}

if (import.meta.main) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
