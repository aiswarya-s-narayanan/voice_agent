require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const PRODUCT_API = process.env.PRODUCT_API;
const PRODUCT_CATEGORY_API = process.env.PRODUCT_CATEGORY_API;
const TOKEN = process.env.TOKEN;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory order store (replace with DB in production)
const orders = [];
const kitchenClients = new Set();

// ─── WebSocket for Kitchen Display ───────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  if (url.pathname === '/kitchen') {
    kitchenClients.add(ws);
    console.log(`[WS] Kitchen client connected. Total: ${kitchenClients.size}`);

    // Send all pending orders to newly connected kitchen screen
    ws.send(JSON.stringify({ type: 'INIT_ORDERS', orders: orders.filter(o => o.status !== 'completed') }));

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'UPDATE_STATUS') {
          const order = orders.find(o => o.id === data.orderId);
          if (order) {
            order.status = data.status;
            broadcastToKitchen({ type: 'ORDER_UPDATED', order });
          }
        }
      } catch (e) { console.error('[WS] parse error', e); }
    });

    ws.on('close', () => {
      kitchenClients.delete(ws);
      console.log(`[WS] Kitchen client disconnected. Total: ${kitchenClients.size}`);
    });
  }
});

function broadcastToKitchen(data) {
  const msg = JSON.stringify(data);
  for (const client of kitchenClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ─── API Proxy Routes ─────────────────────────────────────────────────────────
const apiHeaders = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
});

app.get('/api/categories', async (req, res) => {
  try {
    const resp = await fetch(PRODUCT_CATEGORY_API, { headers: apiHeaders() });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('[API] categories error', err);
    res.status(500).json({ error: 'Failed to fetch categories', details: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const url = new URL(PRODUCT_API);
    if (req.query.categoryId) url.searchParams.set('categoryId', req.query.categoryId);
    if (req.query.search) url.searchParams.set('search', req.query.search);
    const resp = await fetch(url.toString(), { headers: apiHeaders() });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('[API] products error', err);
    res.status(500).json({ error: 'Failed to fetch products', details: err.message });
  }
});

// ─── Order Routes ─────────────────────────────────────────────────────────────
app.post('/api/orders', (req, res) => {
  try {
    const { items, tableNumber, customerName } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid order: items required' });
    }

    const order = {
      id: uuidv4(),
      orderId: `ORD-${Date.now().toString().slice(-6)}`,
      items,
      tableNumber: tableNumber || 'Counter',
      customerName: customerName || 'Guest',
      status: 'pending',
      createdAt: new Date().toISOString(),
      total: items.reduce((sum, i) => sum + (i.price * i.quantity), 0),
    };

    orders.push(order);
    broadcastToKitchen({ type: 'NEW_ORDER', order });
    console.log(`[ORDER] New order ${order.orderId} with ${items.length} items`);
    res.json({ success: true, order });
  } catch (err) {
    console.error('[ORDER] error', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/orders', (req, res) => {
  res.json({ orders });
});

app.patch('/api/orders/:id/status', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = req.body.status;
  broadcastToKitchen({ type: 'ORDER_UPDATED', order });
  res.json({ success: true, order });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve index.html for all unmatched routes (SPA fallback)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n🍽️  Restaurant AI Voice Assistant Server`);
  console.log(`   ► Kiosk:   http://localhost:${PORT}`);
  console.log(`   ► Kitchen: http://localhost:${PORT}/kitchen.html`);
  console.log(`   ► Health:  http://localhost:${PORT}/health\n`);
});
