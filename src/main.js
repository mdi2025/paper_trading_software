import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

// --- State Management ---
const STORAGE_KEY = 'btc_paper_trader_state_v2';

const defaultState = {
  cash: 10000.0,
  positions: {}, // e.g. { 'BTCUSDT': { amount: 0, avgEntryPrice: 0 }, 'BTC-260626-140000-C': { amount: 0, avgEntryPrice: 0 } }
  history: [], 
};

let state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultState;
if (state.crypto !== undefined) { // Migration from v1
  state = defaultState;
}

let activeSymbol = 'BTCUSDT';
let currentPrice = 0;
let latestPrices = {}; // to track prices for portfolio value
let currentWs = null;
let activeSymbolPollInterval = null;
let pnlRefreshInterval = null;

// --- DOM Elements ---
const elTotalValue = document.getElementById('total-value');
const elCashBalance = document.getElementById('cash-balance');
const elBtcHoldings = document.getElementById('btc-holdings');
const elLivePrice = document.getElementById('live-price');
const elEstimatedValue = document.getElementById('estimated-value');
const elTradeAmount = document.getElementById('trade-amount');
const elTradeFeedback = document.getElementById('trade-feedback');
const tbodyHistory = document.getElementById('history-tbody');
const tbodyPositions = document.getElementById('positions-tbody');
const btnBuy = document.getElementById('btn-buy');
const btnSell = document.getElementById('btn-sell');

const elActiveSymbolTitle = document.getElementById('active-symbol-title');
const btnSpotBtc = document.getElementById('btn-spot-btc');

const elOrderPnlGroup = document.getElementById('order-pnl-group');
const elOrderPositionSize = document.getElementById('order-position-size');
const elOrderPnlValue = document.getElementById('order-pnl-value');

// Market Stats DOM Elements
const elStatCurrent = document.getElementById('stat-current');
const elStatWeekLow = document.getElementById('stat-week-low');
const elStatWeekHigh = document.getElementById('stat-week-high');

// Options DOM Elements
const elExpirySelect = document.getElementById('expiry-select');
const tbodyOptions = document.getElementById('options-tbody');

const elNavBtcPriceValue = document.getElementById('nav-btc-price-value');

let optionsData = {}; // Grouped by Expiration Date
let availableExpiries = [];

// Initialize with sample data
function initSampleOptionsData() {
  const today = new Date();
  const expiry1 = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const expiry2Date = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiry2 = `${String(expiry2Date.getFullYear()).slice(2)}${String(expiry2Date.getMonth() + 1).padStart(2, '0')}${String(expiry2Date.getDate()).padStart(2, '0')}`;
  
  const basePrice = 43000;
  const strikes = [41000, 42000, 43000, 44000, 45000];
  
  optionsData = {};
  [expiry1, expiry2].forEach(expiry => {
    optionsData[expiry] = {};
    strikes.forEach(strike => {
      const callValue = Math.max(100, basePrice - strike + 50);
      const putValue = Math.max(100, strike - basePrice + 50);
      optionsData[expiry][strike] = {
        C: { 
          symbol: `BTC-${expiry}-${strike}-C`, 
          lastPrice: callValue, 
          bidPrice: callValue * 0.95, 
          askPrice: callValue * 1.05 
        },
        P: { 
          symbol: `BTC-${expiry}-${strike}-P`, 
          lastPrice: putValue, 
          bidPrice: putValue * 0.95, 
          askPrice: putValue * 1.05 
        }
      };
    });
  });
  
  availableExpiries = [expiry1, expiry2];
}

function updateNavBtcPrice(price) {
  if (!elNavBtcPriceValue) return;
  if (isNaN(price) || price <= 0) return;
  elNavBtcPriceValue.innerText = formatUSD(price);
}

// --- Formatters ---
const formatUSD = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
const formatCrypto = (val) => val.toFixed(8);
const formatTime = (ts) => new Date(ts).toLocaleTimeString();

// --- Chart Initialization ---
const chartContainer = document.getElementById('tvchart');
const chart = createChart(chartContainer, {
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: '#94a3b8',
  },
  grid: {
    vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
    horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
  },
  crosshair: {
    mode: 0,
  },
  rightPriceScale: {
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  timeScale: {
    borderColor: 'rgba(255, 255, 255, 0.1)',
    timeVisible: true,
    secondsVisible: false,
  },
});

const candleSeries = chart.addSeries(CandlestickSeries, {
  upColor: '#10b981',
  downColor: '#ef4444',
  borderDownColor: '#ef4444',
  borderUpColor: '#10b981',
  wickDownColor: '#ef4444',
  wickUpColor: '#10b981',
});

// Handle resize
new ResizeObserver(entries => {
  if (entries.length === 0 || entries[0].target !== chartContainer) { return; }
  const newRect = entries[0].contentRect;
  chart.applyOptions({ height: newRect.height, width: newRect.width });
}).observe(chartContainer);

// --- Fetch Initial History Data ---
async function fetchActiveSymbolPriceREST() {
  try {
    const res = activeSymbol.includes('-')
      ? await fetch(`/eapi/v1/ticker/price?symbol=${activeSymbol}`)
      : await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${activeSymbol}`);

    const data = await res.json();
    const price = parseFloat(data.price ?? data.lastPrice ?? data.close);
    if (!isNaN(price)) {
      const updated = price !== currentPrice;
      currentPrice = price;
      latestPrices[activeSymbol] = currentPrice;
      elLivePrice.classList.remove('loading', 'up', 'down');
      elLivePrice.innerText = formatUSD(currentPrice);
      if (activeSymbol === 'BTCUSDT') {
        updateNavBtcPrice(currentPrice);
      }
      if (updated) updateUI();
    }
  } catch (error) {
    console.error('Active symbol REST fallback failed:', error);
  }
}

function stopActiveSymbolPolling() {
  if (activeSymbolPollInterval) {
    clearInterval(activeSymbolPollInterval);
    activeSymbolPollInterval = null;
  }
}

function startActiveSymbolPolling() {
  stopActiveSymbolPolling();
  activeSymbolPollInterval = setInterval(fetchActiveSymbolPriceREST, 1000);
}

function stopRealtimePnLRefresh() {
  if (pnlRefreshInterval) {
    clearInterval(pnlRefreshInterval);
    pnlRefreshInterval = null;
  }
}

async function fetchOpenPositionPrices() {
  const openSymbols = Object.keys(state.positions).filter(sym => state.positions[sym].amount > 0);
  if (openSymbols.length === 0) return;

  await Promise.all(openSymbols.map(async (symbol) => {
    try {
      const url = symbol.includes('-')
        ? `/eapi/v1/ticker/price?symbol=${symbol}`
        : `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
      const res = await fetch(url);
      const data = await res.json();
      const price = parseFloat(data.price ?? data.lastPrice ?? data.close);
      if (!isNaN(price)) {
        latestPrices[symbol] = price;
      }
    } catch (error) {
      console.error(`Failed to refresh price for ${symbol}:`, error);
    }
  }));
}

function refreshRealtimePnL() {
  const hasOpenPositions = Object.values(state.positions).some(pos => pos.amount > 0);
  if (!hasOpenPositions) return;

  fetchOpenPositionPrices()
    .then(() => updateUI())
    .catch(() => updateUI());
}

function startRealtimePnLRefresh() {
  stopRealtimePnLRefresh();
  pnlRefreshInterval = setInterval(refreshRealtimePnL, 1000);
}

async function fetchHistoricalData() {
  try {
    const isOption = activeSymbol.includes('-');
    const baseUrl = isOption ? '/eapi/v1/klines' : 'https://api.binance.com/api/v3/klines';
    
    const res = await fetch(`${baseUrl}?symbol=${activeSymbol}&interval=1m&limit=500`);
    const data = await res.json();
    if (data.code) throw new Error(data.msg);

    const formattedData = data.map(d => ({
      time: d[0] / 1000,
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
    }));
    candleSeries.setData(formattedData);
    if (formattedData.length > 0) {
      currentPrice = formattedData[formattedData.length - 1].close;
      latestPrices[activeSymbol] = currentPrice;
      updateUI();
    }
  } catch (error) {
    console.error('Error fetching historical data:', error);
    showFeedback('Failed to load historical data', 'error');
    await fetchActiveSymbolPriceREST();
  }
}

// --- WebSocket connection ---
function connectWebSocket() {
  if (currentWs) {
    currentWs.onclose = null; // Prevent reconnect loop on intentional close
    currentWs.close();
  }

  const isOption = activeSymbol.includes('-');
  const wsUrl = isOption 
    ? `wss://eapi.binance.com/eapi/ws/${activeSymbol.toLowerCase()}@kline_1m`
    : `wss://stream.binance.com:9443/ws/${activeSymbol.toLowerCase()}@kline_1m`;

  const ws = new WebSocket(wsUrl);
  currentWs = ws;
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const kline = message.k;
    
    const candleData = {
      time: kline.t / 1000,
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
    };
    
    candleSeries.update(candleData);
    
    // Update live price
    const newPrice = candleData.close;
    if (newPrice !== currentPrice) {
      elLivePrice.classList.remove('loading', 'up', 'down');
      if (newPrice > currentPrice) {
        elLivePrice.classList.add('up');
      } else if (newPrice < currentPrice) {
        elLivePrice.classList.add('down');
      }
      currentPrice = newPrice;
      latestPrices[activeSymbol] = currentPrice;
      elLivePrice.innerText = formatUSD(currentPrice);
      if (activeSymbol === 'BTCUSDT') {
        updateNavBtcPrice(currentPrice);
      }
      updateUI();
    }
  };

  ws.onerror = async (error) => {
    console.error('WebSocket Error:', error);
    elLivePrice.innerText = 'Disconnected';
    await fetchActiveSymbolPriceREST();
  };
  
  ws.onclose = () => {
    console.log('WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  };
}

// Global BTC WebSocket for Navbar
let globalBtcWs = null;

async function fetchGlobalBtcPriceREST() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await res.json();
    const price = parseFloat(data.price);
    if (!isNaN(price)) {
      latestPrices['BTCUSDT'] = price;
      updateNavBtcPrice(price);
      if (activeSymbol === 'BTCUSDT') {
        currentPrice = price;
        elLivePrice.classList.remove('loading', 'up', 'down');
        elLivePrice.innerText = formatUSD(currentPrice);
        updateUI();
      }
    }
  } catch (error) {
    console.error('REST fallback failed:', error);
  }
}

function connectGlobalBtcWebSocket() {
  if (globalBtcWs) {
    globalBtcWs.onclose = null;
    globalBtcWs.close();
  }
  globalBtcWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
  
  let restInterval = null;

  globalBtcWs.onopen = () => {
    if (restInterval) {
      clearInterval(restInterval);
      restInterval = null;
    }
  };

  globalBtcWs.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message && message.c) {
        const price = parseFloat(message.c);
        latestPrices['BTCUSDT'] = price;
        updateNavBtcPrice(price);
        if (activeSymbol === 'BTCUSDT') {
          currentPrice = price;
          elLivePrice.classList.remove('loading', 'up', 'down');
          elLivePrice.innerText = formatUSD(currentPrice);
          updateUI();
        }
      }
    } catch (e) {
      console.error('Error parsing BTC ticker data:', e);
    }
  };
  
  globalBtcWs.onerror = () => {
    fetchGlobalBtcPriceREST();
  };
  
  globalBtcWs.onclose = () => {
    fetchGlobalBtcPriceREST();
    if (!restInterval) {
      // Start fallback polling while waiting for reconnect
      restInterval = setInterval(fetchGlobalBtcPriceREST, 3000);
    }
    setTimeout(connectGlobalBtcWebSocket, 5000);
  };
}

// --- Fetch Options Data ---
async function fetchOptionsData() {
  try {
    const res = await fetch('/eapi/v1/ticker');
    const data = await res.json();
    
    const parsedData = {};
    const strikesSet = new Set();
    const expiriesSet = new Set();

    data.forEach(ticker => {
      const parts = ticker.symbol.split('-');
      if (parts.length !== 4 || parts[0] !== 'BTC') return;
      
      latestPrices[ticker.symbol] = parseFloat(ticker.lastPrice);

      const expiry = parts[1];
      const strike = parseInt(parts[2]);
      const type = parts[3]; 

      expiriesSet.add(expiry);
      strikesSet.add(strike);

      if (!parsedData[expiry]) parsedData[expiry] = {};
      if (!parsedData[expiry][strike]) parsedData[expiry][strike] = { C: null, P: null };

      parsedData[expiry][strike][type] = ticker;
    });

    optionsData = parsedData;
    availableExpiries = Array.from(expiriesSet).sort();

    if (elExpirySelect.options.length <= 1) {
      populateExpiryDropdown();
    } else {
      renderOptionsChain();
    }
    updateUI();
  } catch (error) {
    console.error('Error fetching options data:', error);
    // Fallback: Generate sample options data for display
    const today = new Date();
    const expiry1 = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const expiry2Date = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expiry2 = `${String(expiry2Date.getFullYear()).slice(2)}${String(expiry2Date.getMonth() + 1).padStart(2, '0')}${String(expiry2Date.getDate()).padStart(2, '0')}`;
    
    const basePrice = Math.floor(currentPrice || 43000);
    const strikes = [
      Math.floor(basePrice - 2000),
      Math.floor(basePrice - 1000),
      Math.floor(basePrice),
      Math.floor(basePrice + 1000),
      Math.floor(basePrice + 2000)
    ].filter(s => s > 0);
    
    optionsData = {};
    [expiry1, expiry2].forEach(expiry => {
      optionsData[expiry] = {};
      strikes.forEach(strike => {
        const callValue = Math.max(100, basePrice - strike + 50);
        const putValue = Math.max(100, strike - basePrice + 50);
        optionsData[expiry][strike] = {
          C: { 
            symbol: `BTC-${expiry}-${strike}-C`, 
            lastPrice: callValue, 
            bidPrice: callValue * 0.95, 
            askPrice: callValue * 1.05 
          },
          P: { 
            symbol: `BTC-${expiry}-${strike}-P`, 
            lastPrice: putValue, 
            bidPrice: putValue * 0.95, 
            askPrice: putValue * 1.05 
          }
        };
      });
    });
    
    availableExpiries = [expiry1, expiry2];
    console.log('Sample options data generated:', optionsData);
    populateExpiryDropdown();
    updateUI();
    showFeedback('Showing sample options data (real data unavailable)', 'warning');
  }
}

function populateExpiryDropdown() {
  if (availableExpiries.length === 0) return;
  
  elExpirySelect.innerHTML = '';
  availableExpiries.forEach(exp => {
    const option = document.createElement('option');
    option.value = exp;
    
    const yy = exp.substring(0, 2);
    const mm = exp.substring(2, 4);
    const dd = exp.substring(4, 6);
    option.innerText = `20${yy}-${mm}-${dd}`;
    
    elExpirySelect.appendChild(option);
  });

  elExpirySelect.value = availableExpiries[0];
  renderOptionsChain();
}

function renderOptionsChain() {
  const selectedExpiry = elExpirySelect.value;
  if (!selectedExpiry) {
    console.warn('No expiry selected');
    return;
  }
  if (!optionsData[selectedExpiry]) {
    console.warn('No options data for expiry:', selectedExpiry);
    return;
  }

  tbodyOptions.innerHTML = '';
  const expiryData = optionsData[selectedExpiry];
  const strikes = Object.keys(expiryData).map(Number).sort((a, b) => a - b);

  let atmStrike = strikes[0];
  if (currentPrice > 0) {
    let minDiff = Math.abs(currentPrice - strikes[0]);
    strikes.forEach(s => {
      const diff = Math.abs(currentPrice - s);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = s;
      }
    });
  }

  strikes.forEach(strike => {
    const callData = expiryData[strike].C || {};
    const putData = expiryData[strike].P || {};

    const tr = document.createElement('tr');
    if (currentPrice > 0 && strike === atmStrike) {
      tr.classList.add('atm-row');
    }
    
    // Call cells
    const tdCallBid = document.createElement('td'); tdCallBid.className = 'call-col'; tdCallBid.innerText = formatUSD(callData.bidPrice || 0);
    const tdCallAsk = document.createElement('td'); tdCallAsk.className = 'call-col'; tdCallAsk.innerText = formatUSD(callData.askPrice || 0);
    const tdCallLast = document.createElement('td'); tdCallLast.className = 'call-col font-bold'; tdCallLast.innerText = formatUSD(callData.lastPrice || 0);
    
    if (callData.symbol) {
      const clickHandler = () => switchTradingSymbol(callData.symbol);
      tdCallBid.onclick = clickHandler;
      tdCallAsk.onclick = clickHandler;
      tdCallLast.onclick = clickHandler;
    }

    // Strike cell
    const tdStrike = document.createElement('td'); tdStrike.className = 'strike-col'; tdStrike.innerText = formatUSD(strike);

    // Put cells
    const tdPutLast = document.createElement('td'); tdPutLast.className = 'put-col font-bold'; tdPutLast.innerText = formatUSD(putData.lastPrice || 0);
    const tdPutBid = document.createElement('td'); tdPutBid.className = 'put-col'; tdPutBid.innerText = formatUSD(putData.bidPrice || 0);
    const tdPutAsk = document.createElement('td'); tdPutAsk.className = 'put-col'; tdPutAsk.innerText = formatUSD(putData.askPrice || 0);

    if (putData.symbol) {
      const clickHandler = () => switchTradingSymbol(putData.symbol);
      tdPutLast.onclick = clickHandler;
      tdPutBid.onclick = clickHandler;
      tdPutAsk.onclick = clickHandler;
    }

    tr.appendChild(tdCallBid);
    tr.appendChild(tdCallAsk);
    tr.appendChild(tdCallLast);
    tr.appendChild(tdStrike);
    tr.appendChild(tdPutLast);
    tr.appendChild(tdPutBid);
    tr.appendChild(tdPutAsk);
    
    tbodyOptions.appendChild(tr);
  });
}

function switchTradingSymbol(symbol) {
  activeSymbol = symbol;
  elActiveSymbolTitle.innerText = activeSymbol;
  elLivePrice.innerText = 'Loading...';
  elLivePrice.className = 'live-price loading';
  
  btnSpotBtc.style.display = activeSymbol === 'BTCUSDT' ? 'none' : 'block';
  startActiveSymbolPolling();

  // Switch tab visually
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-target="view-trading"]').classList.add('active');
  document.querySelectorAll('.view-section').forEach(v => {
    v.classList.remove('active-view');
    v.style.display = 'none';
  });
  const tradingView = document.getElementById('view-trading');
  tradingView.classList.add('active-view');
  tradingView.style.display = 'flex';

  setTimeout(() => {
    const newRect = chartContainer.getBoundingClientRect();
    chart.applyOptions({ height: newRect.height, width: newRect.width });
  }, 0);

  fetchHistoricalData().then(() => connectWebSocket());
  updateMarketStats();
  updateUI();
}

async function updateMarketStats() {
  if (!elStatWeekLow || !elStatWeekHigh) return;
  elStatWeekLow.value = 'Loading...';
  elStatWeekHigh.value = 'Loading...';
  
  try {
    const isOption = activeSymbol.includes('-');
    const baseUrl = isOption ? '/eapi/v1/klines' : 'https://api.binance.com/api/v3/klines';
    
    const res = await fetch(`${baseUrl}?symbol=${activeSymbol}&interval=1d&limit=7`);
    const data = await res.json();
    
    if (data && !data.code && data.length > 0) {
      let weekLow = Infinity;
      let weekHigh = -Infinity;
      
      data.forEach(candle => {
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        if (low < weekLow) weekLow = low;
        if (high > weekHigh) weekHigh = high;
      });
      
      elStatWeekLow.value = formatUSD(weekLow);
      elStatWeekHigh.value = formatUSD(weekHigh);
    } else {
      elStatWeekLow.value = 'N/A';
      elStatWeekHigh.value = 'N/A';
    }
  } catch (error) {
    console.error('Error fetching market stats:', error);
    elStatWeekLow.value = 'Error';
    elStatWeekHigh.value = 'Error';
  }
}

elExpirySelect.addEventListener('change', renderOptionsChain);
btnSpotBtc.addEventListener('click', () => switchTradingSymbol('BTCUSDT'));

document.querySelectorAll('.refresh-data-btn').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    const target = e.currentTarget;
    target.disabled = true;
    await fetchOptionsData();
    target.disabled = false;
  });
});

// --- Update UI ---
function updateUI() {
  let cryptoValue = 0;
  Object.keys(state.positions).forEach(sym => {
    const pos = state.positions[sym];
    const price = sym === activeSymbol ? currentPrice : (latestPrices[sym] || pos.avgEntryPrice);
    cryptoValue += (pos.amount * price);
  });

  const totalValue = state.cash + cryptoValue;
  
  elTotalValue.innerText = formatUSD(totalValue);
  elCashBalance.innerText = formatUSD(state.cash);
  
  const activePos = state.positions[activeSymbol];
  elBtcHoldings.innerText = activePos ? formatCrypto(activePos.amount) : '0.00000000';
  document.querySelector('.summary-item:last-child .label').innerText = `${activeSymbol} Holdings`;
  
  if (activePos && activePos.amount > 0) {
    elOrderPnlGroup.style.display = 'block';
    elOrderPositionSize.innerText = formatCrypto(activePos.amount);
    const pnl = (currentPrice - activePos.avgEntryPrice) * activePos.amount;
    const pnlClass = pnl >= 0 ? 'type-buy' : 'type-sell';
    const pnlPrefix = pnl >= 0 ? '+' : '';
    elOrderPnlValue.innerText = `${pnlPrefix}${formatUSD(pnl)}`;
    elOrderPnlValue.className = pnlClass;
  } else {
    elOrderPnlGroup.style.display = 'none';
  }

  updateEstimatedValue();
  if (activeSymbol === 'BTCUSDT' && currentPrice > 0) {
    updateNavBtcPrice(currentPrice);
  }
  renderPositions();
  renderHistory();
  
  if (elStatCurrent) {
    elStatCurrent.value = currentPrice > 0 ? formatUSD(currentPrice) : 'Loading...';
  }
  
  saveState();
}

function updateEstimatedValue() {
  const amount = parseFloat(elTradeAmount.value) || 0;
  elEstimatedValue.innerText = formatUSD(amount * currentPrice);
}

function renderPositions() {
  tbodyPositions.innerHTML = '';

  Object.keys(state.positions).forEach(sym => {
    const pos = state.positions[sym];
    if (pos.amount <= 0) return;

    const price = sym === activeSymbol ? currentPrice : (latestPrices[sym] || pos.avgEntryPrice);
    const pnl = (price - pos.avgEntryPrice) * pos.amount;
    const pnlClass = pnl >= 0 ? 'type-buy' : 'type-sell';
    const pnlPrefix = pnl >= 0 ? '+' : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${sym}</td>
      <td>${formatCrypto(pos.amount)}</td>
      <td>${formatUSD(pos.avgEntryPrice)}</td>
      <td>${formatUSD(price)}</td>
      <td class="${pnlClass}">${pnlPrefix}${formatUSD(pnl)}</td>
      <td><button class="btn sell-btn close-btn" data-symbol="${sym}">Close</button></td>
    `;
    tbodyPositions.appendChild(tr);
  });

  document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sym = e.target.getAttribute('data-symbol');
      closePosition(sym);
    });
  });
}

function renderHistory() {
  tbodyHistory.innerHTML = '';
  const displayHistory = [...state.history].reverse().slice(0, 50);
  
  displayHistory.forEach(trade => {
    const tr = document.createElement('tr');
    
    let pnlHtml = '-';
    if (trade.pnl !== undefined) {
      const pnlClass = trade.pnl >= 0 ? 'type-buy' : 'type-sell';
      const pnlPrefix = trade.pnl >= 0 ? '+' : '';
      pnlHtml = `<span class="${pnlClass}">${pnlPrefix}${formatUSD(trade.pnl)}</span>`;
    }

    tr.innerHTML = `
      <td class="type-${trade.type.toLowerCase()}">${trade.type}</td>
      <td>${trade.symbol}</td>
      <td>${formatUSD(trade.price)}</td>
      <td>${formatCrypto(trade.amount)}</td>
      <td>${pnlHtml}</td>
      <td>${formatTime(trade.timestamp)}</td>
    `;
    tbodyHistory.appendChild(tr);
  });
}

function showFeedback(msg, type) {
  elTradeFeedback.innerText = msg;
  elTradeFeedback.className = `feedback-msg ${type}`;
  setTimeout(() => {
    elTradeFeedback.innerText = '';
  }, 3000);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function closePosition(symbol) {
  const pos = state.positions[symbol];
  if (!pos || pos.amount <= 0) return;

  const price = symbol === activeSymbol ? currentPrice : (latestPrices[symbol] || pos.avgEntryPrice);
  if (price <= 0) {
    showFeedback('Waiting for price...', 'error');
    return;
  }

  const amount = pos.amount;
  const valueUSD = amount * price;
  const realizedPnl = (price - pos.avgEntryPrice) * amount;

  state.cash += valueUSD;
  pos.amount = 0.0;
  pos.avgEntryPrice = 0.0;
  latestPrices[symbol] = price;

  state.history.push({
    type: 'SELL',
    symbol: symbol,
    price: price,
    amount,
    pnl: realizedPnl,
    timestamp: Date.now()
  });

  showFeedback(`Successfully closed ${symbol} position`, 'success');
  updateUI();
}

// --- Trading Logic ---
function executeTrade(type) {
  if (currentPrice <= 0) {
    showFeedback('Waiting for live price...', 'error');
    return;
  }
  
  const amount = parseFloat(elTradeAmount.value);
  if (isNaN(amount) || amount <= 0) {
    showFeedback('Enter a valid amount', 'error');
    return;
  }

  const valueUSD = amount * currentPrice;
  if (!state.positions[activeSymbol]) {
    state.positions[activeSymbol] = { amount: 0, avgEntryPrice: 0 };
  }
  const pos = state.positions[activeSymbol];

  let realizedPnl = null;
  if (type === 'BUY') {
    if (valueUSD > state.cash) {
      showFeedback('Insufficient USD balance', 'error');
      return;
    }
    const totalCostBefore = pos.amount * pos.avgEntryPrice;
    const newTotalCost = totalCostBefore + valueUSD;
    state.cash -= valueUSD;
    pos.amount += amount;
    pos.avgEntryPrice = newTotalCost / pos.amount;
    // Ensure we have a recent market price stored for this symbol
    latestPrices[activeSymbol] = currentPrice;
  } else if (type === 'SELL') {
    if (amount > pos.amount) {
      showFeedback(`Insufficient ${activeSymbol} balance`, 'error');
      return;
    }
    realizedPnl = (currentPrice - pos.avgEntryPrice) * amount;
    state.cash += valueUSD;
    pos.amount -= amount;
    if (pos.amount <= 0.00000001) { 
      pos.amount = 0.0;
      pos.avgEntryPrice = 0.0;
    }
    // Update last known price for this symbol after sell
    latestPrices[activeSymbol] = currentPrice;
  }

  const tradeRecord = {
    type,
    symbol: activeSymbol,
    price: currentPrice,
    amount,
    timestamp: Date.now()
  };
  if (realizedPnl !== null) {
    tradeRecord.pnl = realizedPnl;
  }
  state.history.push(tradeRecord);

  elTradeAmount.value = '';
  showFeedback(`Successfully ${type === 'BUY' ? 'bought' : 'sold'} ${amount} ${activeSymbol}`, 'success');
  updateUI();
}

// --- Event Listeners ---
const btnToggleChart = document.getElementById('btn-toggle-chart');
if (btnToggleChart) {
  btnToggleChart.addEventListener('click', () => {
    if (chartContainer.style.display === 'none') {
      chartContainer.style.display = 'flex';
      btnToggleChart.innerText = 'Hide Chart';
      // Force resize to fix layout
      setTimeout(() => {
        const newRect = chartContainer.getBoundingClientRect();
        chart.applyOptions({ height: newRect.height, width: newRect.width });
      }, 0);
    } else {
      chartContainer.style.display = 'none';
      btnToggleChart.innerText = 'Show Chart';
    }
  });
}

elTradeAmount.addEventListener('input', updateEstimatedValue);
btnBuy.addEventListener('click', () => executeTrade('BUY'));
btnSell.addEventListener('click', () => executeTrade('SELL'));

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  // Ignore clicks on btnSpotBtc if handled separately, but it's a nav-btn too.
  if (!btn || btn.id === 'btn-spot-btc') return; 
  
  const targetId = btn.getAttribute('data-target');
  if (!targetId) return;

  const navBtns = document.querySelectorAll('.nav-btn:not(#btn-spot-btc)');
  const views = document.querySelectorAll('.view-section');

  navBtns.forEach(b => b.classList.remove('active'));
  views.forEach(v => {
    v.classList.remove('active-view');
    v.style.display = 'none';
  });

  btn.classList.add('active');
  
  const targetView = document.getElementById(targetId);
  if (targetView) {
    targetView.classList.add('active-view');
    targetView.style.display = 'flex';
  }

  if (targetId === 'view-trading') {
    setTimeout(() => {
      const newRect = chartContainer.getBoundingClientRect();
      chart.applyOptions({ height: newRect.height, width: newRect.width });
    }, 0);
  }
});

// --- Predictions Logic ---
const btnRefreshPredictions = document.getElementById('btn-refresh-predictions');
const tbodyPredictions = document.getElementById('predictions-tbody');

const ASSETS_TO_PREDICT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT'];

function calculateSMA(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(data.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = calculateSMA(data.slice(0, period), period);
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * k + ema;
  }
  return ema;
}

function calculateRSI(data, period = 14) {
  if (data.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchOrderBookImbalance(symbol) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=100`);
    const data = await res.json();
    if (!data.bids) return 0.5;
    const bidVol = data.bids.reduce((acc, val) => acc + parseFloat(val[1]), 0);
    const askVol = data.asks.reduce((acc, val) => acc + parseFloat(val[1]), 0);
    return bidVol / (bidVol + askVol);
  } catch (e) { return 0.5; }
}

async function fetchFuturesData(symbol) {
  try {
    const frRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
    const frData = await frRes.json();
    return {
      fundingRate: parseFloat(frData.lastFundingRate || 0)
    };
  } catch(e) {
    return { fundingRate: 0 };
  }
}

async function analyzeAsset(symbol) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=250`);
    const klines = await res.json();
    if (!klines || klines.length < 200) return null;

    const closes  = klines.map(k => parseFloat(k[4]));
    const volumes = klines.map(k => parseFloat(k[5]));

    const ma50  = calculateSMA(closes, 50);
    const ma200 = calculateSMA(closes, 200);
    const rsi   = calculateRSI(closes, 14) || 50;

    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdBullish = !!(ema12 && ema26 && ema12 > ema26);

    const currentVol = volumes[volumes.length - 1];
    const avgVol     = calculateSMA(volumes, 20) || 1;
    const volSurge   = currentVol / avgVol;

    const futures    = await fetchFuturesData(symbol);
    const obImbalance = await fetchOrderBookImbalance(symbol);

    // ── Mathematical Probability Model ──────────────────────────
    // Each factor scored 0–1 (bull friendly), then weighted
    const wTrend    = 0.30;
    const wRSI      = 0.20;
    const wMACD     = 0.20;
    const wVolume   = 0.10;
    const wOI       = 0.10;
    const wFunding  = 0.10;

    const sTrend   = (ma50 && ma200 && ma50 > ma200) ? 1.0 : 0.0;
    // RSI: oversold = bullish, overbought = bearish
    let sRSI = 0.5;
    if (rsi <= 20)      sRSI = 1.0;
    else if (rsi <= 30) sRSI = 0.85;
    else if (rsi <= 40) sRSI = 0.65;
    else if (rsi <= 50) sRSI = 0.5;
    else if (rsi <= 60) sRSI = 0.35;
    else if (rsi <= 70) sRSI = 0.2;
    else                sRSI = 0.05;

    const sMACD    = macdBullish ? 1.0 : 0.0;
    // Volume surge: high with positive trend = bullish
    let sVol = 0.5;
    if (volSurge > 2.0) sVol = sTrend > 0.5 ? 1.0 : 0.0;
    else if (volSurge > 1.5) sVol = sTrend > 0.5 ? 0.8 : 0.2;
    else if (volSurge > 1.0) sVol = 0.55;

    // OI proxy: use order book imbalance as OI signal
    const sOI      = obImbalance; // 0.0 – 1.0 (>0.5 = bid heavy = bullish)
    // Funding: positive = longs paying = slightly bearish, negative = shorts = bullish
    const sfunding  = futures.fundingRate < 0 ? 0.75 : (futures.fundingRate > 0 ? 0.35 : 0.5);

    const bullScore = (wTrend * sTrend + wRSI * sRSI + wMACD * sMACD +
                       wVolume * sVol + wOI * sOI + wFunding * sfunding) * 100;
    const cePercent = Math.round(Math.min(100, Math.max(0, bullScore)));
    const pePercent = 100 - cePercent;

    // Confidence = distance from 50 (higher deviation = more confident)
    const confidence = Math.round(50 + Math.abs(cePercent - 50));
    const risk = confidence > 75 ? 'Low' : (confidence > 60 ? 'Medium' : 'High');
    const riskClass = risk === 'Low' ? 'risk-low' : (risk === 'Medium' ? 'risk-med' : 'risk-high');

    // Signal label
    let signal, badgeClass;
    if (cePercent <= 20)      { signal = 'Strong PE'; badgeClass = 'badge-strong-pe'; }
    else if (cePercent <= 40) { signal = 'PE';        badgeClass = 'badge-pe'; }
    else if (cePercent <= 60) { signal = 'Neutral';   badgeClass = 'badge-neutral'; }
    else if (cePercent <= 80) { signal = 'CE';        badgeClass = 'badge-ce'; }
    else                      { signal = 'Strong CE'; badgeClass = 'badge-strong-ce'; }

    // Direction label
    const direction = cePercent >= 50
      ? `▲ CE (Bullish)`
      : `▼ PE (Bearish)`;
    const dirColor = cePercent >= 50 ? '#10b981' : '#ef4444';

    // Reversal / special detection
    let specialNote = '';
    if (rsi < 25 && macdBullish && volSurge > 1.5) specialNote = '🔄 Reversal Setup';
    else if (closes.at(-1) < ma200 && volSurge > 1.5) specialNote = '📉 Breakdown Setup';
    else if (futures.fundingRate < -0.0005 && obImbalance > 0.6) specialNote = '🚀 Short Squeeze';

    return {
      symbol,
      cePercent, pePercent, confidence, risk, riskClass,
      signal, badgeClass, direction, dirColor, specialNote,
      rsi: rsi.toFixed(1),
      macd: macdBullish ? 'Bullish' : 'Bearish',
      macdColor: macdBullish ? '#10b981' : '#ef4444',
      trend: ma50 > ma200 ? 'Bullish' : 'Bearish',
      trendColor: ma50 > ma200 ? '#10b981' : '#ef4444',
      volSurgePct: `${(volSurge * 100).toFixed(0)}%`,
      funding: `${(futures.fundingRate * 100).toFixed(4)}%`,
      fundingColor: futures.fundingRate < 0 ? '#10b981' : '#ef4444',
      obImb: `${(obImbalance * 100).toFixed(1)}%`,
    };
  } catch(e) {
    console.error(`Analysis failed for ${symbol}`, e);
    return null;
  }
}

function renderPredictionCard(r) {
  const card = document.createElement('div');
  card.className = 'pred-card';
  card.innerHTML = `
    <div class="pred-card-header">
      <span class="pred-symbol">${r.symbol}</span>
      <span class="pred-signal-badge ${r.badgeClass}">${r.signal}</span>
    </div>

    <div class="prob-bar-container">
      <div class="prob-bar-labels">
        <span style="color:#10b981">▲ CE (Bullish)</span>
        <span style="color:#ef4444">▼ PE (Bearish)</span>
      </div>
      <div class="prob-bar-track">
        <div class="prob-bar-fill" style="width:0%" data-width="${r.cePercent}%"></div>
      </div>
      <div class="prob-bar-pcts">
        <span class="prob-ce">${r.cePercent}%</span>
        <span class="prob-pe">${r.pePercent}%</span>
      </div>
    </div>

    <div class="pred-indicators">
      <div class="pred-ind">
        <span class="pred-ind-label">Trend</span>
        <span class="pred-ind-value" style="color:${r.trendColor}">${r.trend}</span>
      </div>
      <div class="pred-ind">
        <span class="pred-ind-label">RSI</span>
        <span class="pred-ind-value">${r.rsi}</span>
      </div>
      <div class="pred-ind">
        <span class="pred-ind-label">MACD</span>
        <span class="pred-ind-value" style="color:${r.macdColor}">${r.macd}</span>
      </div>
      <div class="pred-ind">
        <span class="pred-ind-label">Vol Surge</span>
        <span class="pred-ind-value">${r.volSurgePct}</span>
      </div>
      <div class="pred-ind">
        <span class="pred-ind-label">Order Book</span>
        <span class="pred-ind-value">${r.obImb} Bid</span>
      </div>
      <div class="pred-ind">
        <span class="pred-ind-label">Funding</span>
        <span class="pred-ind-value" style="color:${r.fundingColor}">${r.funding}</span>
      </div>
    </div>

    ${r.specialNote ? `<div style="text-align:center;font-size:0.82rem;padding:0.4rem 0.8rem;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid var(--border-color)">${r.specialNote}</div>` : ''}

    <div class="pred-footer">
      <div>
        <div class="pred-confidence-label">Confidence</div>
        <div class="pred-confidence-value">${r.confidence}%</div>
        <span class="pred-risk ${r.riskClass}">${r.risk} Risk</span>
      </div>
      <div style="text-align:right">
        <div class="pred-direction-label">Expected Direction</div>
        <div class="pred-direction-value" style="color:${r.dirColor}">${r.direction}</div>
      </div>
    </div>
  `;
  // Animate bar after mount
  requestAnimationFrame(() => {
    const fill = card.querySelector('.prob-bar-fill');
    if (fill) fill.style.width = fill.dataset.width;
  });
  return card;
}

const predCardsContainer = document.getElementById('predictions-cards');

if (btnRefreshPredictions) {
  btnRefreshPredictions.addEventListener('click', async () => {
    btnRefreshPredictions.disabled = true;
    predCardsContainer.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-secondary)">
        <div style="font-size:1.1rem;margin-bottom:0.5rem">⚡ Fetching live market data...</div>
        <div style="font-size:0.85rem">Pulling 1h candles · Order book · Funding rate for ${ASSETS_TO_PREDICT.join(', ')}</div>
      </div>`;

    const results = [];
    for (const sym of ASSETS_TO_PREDICT) {
      const res = await analyzeAsset(sym);
      if (res) results.push(res);
    }

    predCardsContainer.innerHTML = '';

    if (results.length === 0) {
      predCardsContainer.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-secondary)">Error fetching market data. Check connection.</div>`;
      btnRefreshPredictions.disabled = false;
      return;
    }

    // Sort by CE probability desc
    results.sort((a, b) => b.cePercent - a.cePercent);
    results.forEach(r => predCardsContainer.appendChild(renderPredictionCard(r)));
    btnRefreshPredictions.disabled = false;
  });
}

// --- Init ---
initSampleOptionsData();
populateExpiryDropdown();

connectGlobalBtcWebSocket();
fetchGlobalBtcPriceREST();
fetchHistoricalData().then(() => {
  connectWebSocket();
});
fetchOptionsData();
setInterval(fetchOptionsData, 30000);
startActiveSymbolPolling();
startRealtimePnLRefresh();

updateMarketStats();
updateUI();
