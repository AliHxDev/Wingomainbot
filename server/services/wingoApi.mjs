import { env } from '../config/env.mjs';
import { logger } from '../utils/logger.mjs';
import { classifyNumber } from './predictionEngine.mjs';

export class WingoApiError extends Error {
  constructor(message, code='WINGO_API_ERROR') { super(message); this.name='WingoApiError'; this.code=code; }
}

function parseRecord(raw) {
  const issue = raw.issueNumber ?? raw.issue ?? raw.period ?? raw.periodNumber ?? raw.issueNo;
  const numberRaw = raw.number ?? raw.result ?? raw.num ?? raw.openCode ?? raw.value;
  if (issue == null || numberRaw == null) return null;
  const number = Number.parseInt(String(numberRaw).match(/\d+/)?.[0] ?? '', 10);
  if (!/^\d{5,40}$/.test(String(issue).trim()) || !Number.isInteger(number) || number < 0 || number > 9) return null;
  const parsed = classifyNumber(number);
  return { issue:String(issue).trim(), number, size:parsed.size, color:parsed.color, baseColor:parsed.baseColor };
}

function extractList(payload) {
  const candidates = [payload?.data?.list, payload?.data?.records, payload?.list, payload?.records, payload?.data];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate;
  throw new WingoApiError('WinGo response did not contain a result list', 'MALFORMED_RESPONSE');
}

function compareIssues(a,b) {
  const ai=BigInt(a.issue), bi=BigInt(b.issue);
  return ai<bi?-1:ai>bi?1:0;
}

export async function fetchWingoHistory() {
  let lastError;
  for (let attempt=0; attempt<=env.REQUEST_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), env.REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(env.WINGO_API_URL, {
        method:'GET',
        headers:{'accept':'application/json','user-agent':'WinGoSignalBot/1.0'},
        signal:controller.signal,
      });
      if (!response.ok) throw new WingoApiError(`WinGo endpoint returned HTTP ${response.status}`, 'HTTP_ERROR');
      const payload = await response.json();
      const list = extractList(payload).map(parseRecord).filter(Boolean);
      if (!list.length) throw new WingoApiError('WinGo response contained no valid results', 'EMPTY_RESULTS');
      const deduped = [...new Map(list.map(r=>[r.issue,r])).values()].sort((a,b)=>compareIssues(a,b));
      return deduped;
    } catch (error) {
      lastError = error.name === 'AbortError' ? new WingoApiError('WinGo request timed out', 'TIMEOUT') : error;
      if (attempt < env.REQUEST_RETRIES) await new Promise(resolve=>setTimeout(resolve, 400 * (2 ** attempt)));
    } finally { clearTimeout(timer); }
  }
  logger.warn({ err:lastError }, 'WinGo history fetch failed');
  throw lastError || new WingoApiError('WinGo request failed');
}

export function nextIssue(issue) {
  if (!/^\d+$/.test(issue)) throw new WingoApiError(`Cannot increment non-numeric issue: ${issue}`, 'BAD_ISSUE');
  return (BigInt(issue)+1n).toString();
}
