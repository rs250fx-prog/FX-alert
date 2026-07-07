// CurrencyFreaksから現在レートを取得し、MXN/JPY・USD/JPY・GOLD(XAU/USD)に変換する共通関数。
// check-rates.js（60分ごと）・record-daily-close.js（1日1回）の両方から使う。

async function fetchRates(apiKey) {
  const url = `https://api.currencyfreaks.com/v2.0/rates/latest?apikey=${apiKey}&symbols=JPY,MXN,XAU`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CurrencyFreaks API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const jpyPerUsd = parseFloat(data.rates.JPY);
  const mxnPerUsd = parseFloat(data.rates.MXN);
  const xauPerUsd = parseFloat(data.rates.XAU); // troy oz per USD（非常に小さい値）

  return {
    USDJPY: jpyPerUsd,
    MXNJPY: jpyPerUsd / mxnPerUsd,
    XAUUSD: 1 / xauPerUsd
  };
}

module.exports = { fetchRates };
