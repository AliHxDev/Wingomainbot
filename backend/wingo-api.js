const axios = require('axios');

const API_URL = process.env.WINGO_API_URL || 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';
const REQUEST_TIMEOUT_MS = Number(process.env.WINGO_HTTP_TIMEOUT_MS || 12_000);
const RETRIES = Number(process.env.WINGO_HTTP_RETRIES || 3);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHistory() {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await axios.get(API_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        params: { pageNo: 1, pageSize: 100 },
        headers: {
          Accept: 'application/json',
          'User-Agent': 'WinGo-Signal-Bot/1.0'
        }
      });
      const list = response?.data?.data?.list;
      if (!Array.isArray(list)) throw new Error('WinGo API returned an unexpected payload');
      return list
        .filter((item) => item && item.issueNumber !== undefined && item.number !== undefined)
        .map((item) => ({
          issueNumber: String(item.issueNumber),
          number: String(item.number),
          color: item.color ? String(item.color).toLowerCase() : '',
          premium: item.premium,
          raw: item
        }))
        .sort((a, b) => compareIssueNumbers(a.issueNumber, b.issueNumber));
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`WinGo API request failed after ${RETRIES} attempts: ${lastError?.message || 'unknown error'}`);
}

function compareIssueNumbers(a, b) {
  try {
    const ai = BigInt(String(a));
    const bi = BigInt(String(b));
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  } catch {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }
}

function incrementIssueNumber(value) {
  try {
    return (BigInt(String(value)) + 1n).toString();
  } catch {
    const match = String(value).match(/^(.*?)(\d+)$/);
    if (!match) throw new Error(`Cannot increment issue number: ${value}`);
    const prefix = match[1];
    const next = String(Number(match[2]) + 1).padStart(match[2].length, '0');
    return `${prefix}${next}`;
  }
}

function deriveSize(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error(`Invalid WinGo number: ${number}`);
  return n <= 4 ? 'SMALL' : 'BIG';
}

function deriveColor(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error(`Invalid WinGo number: ${number}`);
  if (n === 0) return 'RED';
  if (n === 5) return 'GREEN';
  return n % 2 === 0 ? 'RED' : 'GREEN';
}

module.exports = {
  fetchHistory,
  compareIssueNumbers,
  incrementIssueNumber,
  deriveSize,
  deriveColor
};
