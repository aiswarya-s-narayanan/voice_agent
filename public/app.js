/**
 * app.js — Restaurant AI Voice Assistant
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  FireRedVAD (Web Audio API energy-based VAD)                │
 *   │    ↓ speech detected                                        │
 *   │  Web Speech API (SpeechRecognition) — transcription         │
 *   │    ↓ transcript                                             │
 *   │  NLU Engine — intent + entity extraction                    │
 *   │    ↓ intent                                                 │
 *   │  Conversation State Machine (GREETING → ORDERING → CONFIRM) │
 *   │    ↓ response text                                          │
 *   │  TTS Engine (SpeechSynthesis) — Nova's voice                │
 *   │    ↓ order confirmed                                        │
 *   │  Order API → Backend → Kitchen WebSocket                    │
 *   └─────────────────────────────────────────────────────────────┘
 */

// ═══════════════════════════════════════════════════════════════════════════════
// FireRedVAD — Voice Activity Detection using Web Audio API
// Inspired by the FireRedTTS / FireRedVAD approach: energy-based short-time
// energy (STE) threshold combined with zero-crossing rate (ZCR) analysis to
// distinguish speech from silence/noise.
// ═══════════════════════════════════════════════════════════════════════════════
class FireRedVAD {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.frameSize = options.frameSize || 512;
    this.energyThreshold = options.energyThreshold || 0.004;
    this.zcrThreshold = options.zcrThreshold || 0.15;
    this.silenceFrames = options.silenceFrames || 20;   // ~640ms silence → end of speech
    this.speechFrames = options.speechFrames || 4;     // min 4 frames to confirm speech

    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.scriptNode = null;
    this.dataArray = null;

    this._silenceCount = 0;
    this._speechCount = 0;
    this._isSpeaking = false;
    this._running = false;

    this.onSpeechStart = null;
    this.onSpeechEnd = null;
    this.onVolumeUpdate = null;
  }

  async init() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    this.source = this.audioCtx.createMediaStreamSource(this.stream);

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = this.frameSize * 2;
    this.analyser.smoothingTimeConstant = 0.3;

    this.scriptNode = this.audioCtx.createScriptProcessor(this.frameSize, 1, 1);
    this.dataArray = new Float32Array(this.frameSize);

    this.source.connect(this.analyser);
    this.analyser.connect(this.scriptNode);
    this.scriptNode.connect(this.audioCtx.destination);

    this.scriptNode.onaudioprocess = (e) => this._processFrame(e.inputBuffer.getChannelData(0));
    this._running = true;
    console.log('[FireRedVAD] Initialized — sampleRate:', this.sampleRate, 'frameSize:', this.frameSize);
  }

  _computeSTE(samples) {
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    return energy / samples.length;
  }

  _computeZCR(samples) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings++;
    }
    return crossings / (samples.length - 1);
  }

  _processFrame(samples) {
    if (!this._running) return;

    const ste = this._computeSTE(samples);
    const zcr = this._computeZCR(samples);

    // Speech decision: high energy AND reasonable ZCR (not pure noise)
    const isSpeechFrame = ste > this.energyThreshold && zcr < this.zcrThreshold;

    // Volume callback for UI bars (normalized 0..1)
    const volume = Math.min(1, Math.sqrt(ste) * 15);
    if (this.onVolumeUpdate) this.onVolumeUpdate(volume, ste);

    if (isSpeechFrame) {
      this._speechCount++;
      this._silenceCount = 0;
      if (!this._isSpeaking && this._speechCount >= this.speechFrames) {
        this._isSpeaking = true;
        if (this.onSpeechStart) this.onSpeechStart();
      }
    } else {
      this._silenceCount++;
      this._speechCount = 0;
      if (this._isSpeaking && this._silenceCount >= this.silenceFrames) {
        this._isSpeaking = false;
        this._silenceCount = 0;
        if (this.onSpeechEnd) this.onSpeechEnd();
      }
    }
  }

  get isSpeaking() { return this._isSpeaking; }

  destroy() {
    this._running = false;
    if (this.scriptNode) { this.scriptNode.disconnect(); this.scriptNode.onaudioprocess = null; }
    if (this.source) this.source.disconnect();
    if (this.analyser) this.analyser.disconnect();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioCtx) this.audioCtx.close();
    console.log('[FireRedVAD] Destroyed');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NLU — Natural Language Understanding (intent + entity extraction)
// ═══════════════════════════════════════════════════════════════════════════════
const NLU = (() => {
  const INTENTS = {
    GREET:          [/\b(hi|hello|hey|good morning|good afternoon|good evening|namaste|hola)\b/i],
    ORDER:          [/\b(i (want|need|would like|like|ll have|will have)|give me|get me|order|can i (get|have)|i('d)? like|please (get|give|bring))\b/i],
    SHOW_MENU:      [/\b(menu|what (do you have|is available|can i (get|have|order))|show me|list|options|what('s| is) (there|on)|what kind|what type)\b/i],
    CONFIRM:        [/\b(yes|yeah|yep|correct|confirm|that('s| is) (right|correct|good|fine|perfect)|go ahead|place (the )?order|proceed|ok(ay)?|sure)\b/i],
    CANCEL:         [/\b(no|nope|cancel|stop|never mind|forget it|clear|remove|start over|reset)\b/i],
    INCREASE_QTY:   [/\b(add (more|another)|more|increase|one more|extra)\b/i],
    DECREASE_QTY:   [/\b(less|fewer|remove one|decrease|reduce)\b/i],
    HELP:           [/\b(help|what can you do|how does this work|explain)\b/i],
    DONE:           [/\b(that('s| is) (all|it)|nothing else|done|that's everything|finish|complete)\b/i],
  };

  const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1,
  };

  function detectIntent(text) {
    const t = text.toLowerCase();
    for (const [intent, patterns] of Object.entries(INTENTS)) {
      if (patterns.some(rx => rx.test(t))) return intent;
    }
    return 'UNKNOWN';
  }

  function extractQuantity(text) {
    const t = text.toLowerCase();
    // digit numbers first: "2 biryani", "3 burgers"
    const digitMatch = t.match(/\b(\d+)\b/);
    if (digitMatch) return parseInt(digitMatch[1]);
    // word numbers
    for (const [word, val] of Object.entries(NUMBER_WORDS)) {
      if (new RegExp(`\\b${word}\\b`).test(t)) return val;
    }
    return 1;
  }

  function extractFoodItem(text, allProducts) {
    const t = text.toLowerCase();
    // Try to match known product names (longest match first)
    const sorted = [...allProducts].sort((a, b) => b.name.length - a.name.length);
    for (const product of sorted) {
      if (t.includes(product.name.toLowerCase())) return { type: 'product', item: product };
    }
    // Try category keywords
    const catKeywords = allProducts.reduce((acc, p) => {
      const cat = p.category.toLowerCase();
      if (!acc[cat]) acc[cat] = p.categoryId;
      return acc;
    }, {});
    for (const [catName, catId] of Object.entries(catKeywords)) {
      if (t.includes(catName)) return { type: 'category', name: catName, id: catId };
    }
    return null;
  }

  return { detectIntent, extractQuantity, extractFoodItem };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// TTS — Text-to-Speech wrapper
// ═══════════════════════════════════════════════════════════════════════════════
const TTS = (() => {
  let selectedVoice = null;
  let isSpeaking = false;

  function init() {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      // Prefer a female English voice with "natural" feel
      const preferred = ['Samantha', 'Karen', 'Moira', 'Victoria', 'Google UK English Female', 'Microsoft Zira', 'en-GB', 'en-US'];
      selectedVoice = voices.find(v => preferred.some(p => v.name.includes(p) || v.lang.includes(p))) || voices.find(v => v.lang.startsWith('en')) || voices[0];
      if (selectedVoice) console.log('[TTS] Voice selected:', selectedVoice.name);
    };
    if (window.speechSynthesis.getVoices().length) loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  function speak(text, { rate = 0.95, pitch = 1.05, volume = 1, onStart, onEnd } = {}) {
    return new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      if (selectedVoice) utter.voice = selectedVoice;
      utter.rate = rate;
      utter.pitch = pitch;
      utter.volume = volume;
      utter.onstart = () => { isSpeaking = true; if (onStart) onStart(); };
      utter.onend = () => { isSpeaking = false; if (onEnd) onEnd(); resolve(); };
      utter.onerror = () => { isSpeaking = false; resolve(); };
      window.speechSynthesis.speak(utter);
    });
  }

  function stop() { window.speechSynthesis.cancel(); isSpeaking = false; }
  function isActive() { return isSpeaking; }

  return { init, speak, stop, isActive };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MANAGER
// ═══════════════════════════════════════════════════════════════════════════════
const OrderManager = (() => {
  let cart = [];

  function addItem(product, quantity = 1) {
    const existing = cart.find(i => i.id === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.push({ ...product, quantity });
    }
    renderCart();
  }

  function removeItem(productId) {
    cart = cart.filter(i => i.id !== productId);
    renderCart();
  }

  function updateQty(productId, delta) {
    const item = cart.find(i => i.id === productId);
    if (item) {
      item.quantity += delta;
      if (item.quantity <= 0) removeItem(productId);
      else renderCart();
    }
  }

  function clear() { cart = []; renderCart(); }

  function getCart() { return cart; }

  function getTotal() { return cart.reduce((s, i) => s + i.price * i.quantity, 0); }

  function getItemCount() { return cart.reduce((s, i) => s + i.quantity, 0); }

  function cartSummaryText() {
    if (cart.length === 0) return 'Your cart is empty.';
    return cart.map(i => `${i.quantity} ${i.name}`).join(', ');
  }

  function renderCart() {
    const orderItemsEl = document.getElementById('orderItems');
    const orderCountEl = document.getElementById('orderCount');
    const orderFooterEl = document.getElementById('orderFooter');
    const orderTotalEl = document.getElementById('orderTotal');

    if (!orderItemsEl) return;

    const count = getItemCount();
    orderCountEl.textContent = `${count} item${count !== 1 ? 's' : ''}`;

    if (cart.length === 0) {
      orderItemsEl.innerHTML = '<div class="empty-order">No items yet. Start speaking or tap a dish!</div>';
      orderFooterEl.style.display = 'none';
      return;
    }

    orderItemsEl.innerHTML = cart.map(item => `
      <div class="order-line-item" id="oli-${item.id}">
        <span class="oli-emoji">${item.emoji}</span>
        <span class="oli-name">${item.name}</span>
        <div class="oli-qty-ctrl">
          <button class="qty-btn" onclick="OrderManager.updateQty('${item.id}', -1)" aria-label="Decrease">−</button>
          <span class="qty-num">${item.quantity}</span>
          <button class="qty-btn" onclick="OrderManager.updateQty('${item.id}', 1)" aria-label="Increase">+</button>
        </div>
        <span class="oli-price">₹${(item.price * item.quantity).toFixed(2)}</span>
        <button class="oli-del" onclick="OrderManager.removeItem('${item.id}')" aria-label="Remove">✕</button>
      </div>
    `).join('');

    orderTotalEl.textContent = `₹${getTotal().toFixed(2)}`;
    orderFooterEl.style.display = 'block';
  }

  async function submitOrder() {
    if (cart.length === 0) return null;
    const payload = {
      items: cart.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, emoji: i.emoji })),
      tableNumber: 'Counter',
      customerName: 'Voice Customer',
    };
    const resp = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error('Order submission failed');
    const data = await resp.json();
    clear();
    return data.order;
  }

  return { addItem, removeItem, updateQty, clear, getCart, getTotal, getItemCount, cartSummaryText, renderCart, submitOrder };
})();

// expose for onclick handlers
window.OrderManager = OrderManager;

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE ASSISTANT STATE MACHINE
// States: IDLE → LISTENING → THINKING → SPEAKING → ORDERING → CONFIRMING
// ═══════════════════════════════════════════════════════════════════════════════
const VoiceAssistant = (() => {
  const STATES = { IDLE: 'IDLE', LISTENING: 'LISTENING', THINKING: 'THINKING', SPEAKING: 'SPEAKING', ORDERING: 'ORDERING', CONFIRMING: 'CONFIRMING' };
  let state = STATES.IDLE;
  let vad = null;
  let recognition = null;
  let vadActive = false;
  let interimTranscript = '';
  let lastIntentContext = null;  // For multi-turn context
  let pendingCategoryProducts = [];

  // ─── Responses ──────────────────────────────────────────────────────────────
  const RESPONSES = {
    GREET: [
      "Hello! Welcome to TasteAI! 😊 I'm Nova. What would you like to order today?",
      "Hey there! Great to see you! I'm Nova, your AI food assistant. Ready to take your order!",
      "Hi! Welcome! I'm Nova. Our menu has amazing biriyani, burgers, pizzas and more. What sounds good?",
    ],
    HELP: [
      "You can tell me what you'd like to order! For example: 'I want 2 chicken biryani' or 'Show me the menu'. I'll help you pick and confirm your order.",
    ],
    UNKNOWN: [
      "I'm sorry, I didn't catch that. Could you say it again?",
      "Hmm, I didn't understand. You can say 'show menu' or 'I want 2 biryani'.",
      "Could you repeat that? I'm listening carefully this time!",
    ],
    CART_EMPTY: [
      "Your cart is empty! Tell me what you'd like to order.",
    ],
    ORDER_SENT: [
      "Your order has been sent to the kitchen! 🎉 It will be ready shortly. Enjoy your meal!",
    ],
  };

  function randomResponse(key) {
    const arr = RESPONSES[key];
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ─── UI Helpers ──────────────────────────────────────────────────────────────
  function setStatus(text, dotClass = '') {
    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    if (dot) { dot.className = 'status-dot'; if (dotClass) dot.classList.add(dotClass); }
    if (statusText) statusText.textContent = text;
  }

  function setMicState(active) {
    const btn = document.getElementById('micBtn');
    const icon = document.getElementById('micBtnIcon');
    const label = document.getElementById('micBtnLabel');
    const vadBars = document.getElementById('vadBars');
    if (!btn) return;
    if (active) {
      btn.classList.add('active');
      icon.textContent = '⏹️';
      label.textContent = 'Listening...';
      vadBars.classList.add('active');
    } else {
      btn.classList.remove('active');
      icon.textContent = '🎤';
      label.textContent = 'Tap to Speak';
      vadBars.classList.remove('active');
    }
  }

  function setAvatarState(s) {
    const ring = document.getElementById('avatarRing');
    if (!ring) return;
    ring.className = 'avatar-ring';
    if (s === 'listening') ring.classList.add('listening');
    else if (s === 'speaking') ring.classList.add('speaking');
  }

  function updateTranscript(text, isInterim = false) {
    const el = document.getElementById('transcriptText');
    const status = document.getElementById('transcriptStatus');
    if (el) el.textContent = text || '—';
    if (status) status.textContent = isInterim ? '🎙️ Listening...' : (text ? '✅ Heard' : 'Click the mic to start speaking');
  }

  function addMessage(text, sender = 'assistant') {
    const box = document.getElementById('conversationBox');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `chat-msg ${sender}-msg`;
    div.innerHTML = `
      <div class="msg-avatar">${sender === 'assistant' ? '🤖' : '👤'}</div>
      <div class="msg-bubble">${text}</div>
    `;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function setVADBadge(text, active = false) {
    const badge = document.getElementById('vadBadge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'vad-badge' + (active ? ' active' : '');
  }

  // ─── Nova's Voice Response ───────────────────────────────────────────────────
  async function nova(text) {
    state = STATES.SPEAKING;
    setAvatarState('speaking');
    setStatus('Nova is speaking...', '');
    addMessage(text, 'assistant');
    await TTS.speak(text, {
      onEnd: () => {
        setAvatarState('');
        state = STATES.IDLE;
        setStatus('Ready', 'ready');
      },
    });
  }

  // ─── Build Category Prompt ───────────────────────────────────────────────────
  function buildCategoryOptions(products, categoryName) {
    const names = products.slice(0, 6).map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
    return `Here are our ${categoryName} options:\n${names}\n\nWhich one would you like?`;
  }

  function buildMenuOverview() {
    const cats = Menu.getCategories();
    const catNames = cats.slice(0, 6).map(c => c.name).join(', ');
    return `We have ${cats.length} categories: ${catNames}. Which category or item would you like?`;
  }

  // ─── Intent Handler ──────────────────────────────────────────────────────────
  async function handleIntent(text) {
    state = STATES.THINKING;
    setStatus('Thinking...', '');

    const intent = NLU.detectIntent(text);
    const qty = NLU.extractQuantity(text);
    const foodMatch = NLU.extractFoodItem(text, Menu.getAll());

    console.log(`[NLU] intent=${intent} qty=${qty} food=`, foodMatch);

    // ── GREET ────────────────────────────────────────────────────────────────
    if (intent === 'GREET') {
      await nova(randomResponse('GREET'));
      return;
    }

    // ── HELP ─────────────────────────────────────────────────────────────────
    if (intent === 'HELP') {
      await nova(randomResponse('HELP'));
      return;
    }

    // ── SHOW MENU ─────────────────────────────────────────────────────────────
    if (intent === 'SHOW_MENU') {
      if (foodMatch && foodMatch.type === 'category') {
        const { products } = Menu.findByCategory(foodMatch.name);
        if (products.length) {
          pendingCategoryProducts = products;
          lastIntentContext = { type: 'awaiting_selection', category: foodMatch.name, products };
          highlightProducts(products);
          await nova(buildCategoryOptions(products, foodMatch.name));
        } else {
          await nova(`I'm sorry, I couldn't find any ${foodMatch.name} items right now.`);
        }
      } else {
        await nova(buildMenuOverview());
      }
      return;
    }

    // ── ORDER ─────────────────────────────────────────────────────────────────
    if (intent === 'ORDER' || (intent === 'UNKNOWN' && foodMatch)) {
      if (!foodMatch) {
        await nova("Sure! What would you like to order? I have biryani, burgers, pizza, and more!");
        return;
      }

      if (foodMatch.type === 'product') {
        // Exact product match
        OrderManager.addItem(foodMatch.item, qty);
        highlightProduct(foodMatch.item.id);
        lastIntentContext = { type: 'item_added', item: foodMatch.item, qty };
        await nova(`Added ${qty} ${foodMatch.item.name} to your order. 🎉 Anything else?`);

      } else if (foodMatch.type === 'category') {
        // Category match — ask which specific item
        const { category, products } = Menu.findByCategory(foodMatch.name);
        if (products.length === 0) {
          await nova(`I'm sorry, we're out of ${foodMatch.name} right now.`);
          return;
        }
        // If only 1 product in category, add it directly
        if (products.length === 1) {
          OrderManager.addItem(products[0], qty);
          highlightProduct(products[0].id);
          await nova(`Added ${qty} ${products[0].name} to your order! Anything else?`);
          return;
        }
        pendingCategoryProducts = products;
        lastIntentContext = { type: 'awaiting_selection', category: foodMatch.name, qty, products };
        filterMenuByCategory(category ? category.id : 'all');
        highlightProducts(products);
        await nova(buildCategoryOptions(products, foodMatch.name));
      }
      return;
    }

    // ── Handle awaiting selection (user said a number or partial name) ────────
    if (lastIntentContext && lastIntentContext.type === 'awaiting_selection') {
      const products = lastIntentContext.products;
      const savedQty = lastIntentContext.qty || 1;

      // Try number selection ("I'll take number 2" or just "2")
      const numMatch = text.match(/\b([1-9])\b/);
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1;
        if (idx >= 0 && idx < products.length) {
          const chosen = products[idx];
          OrderManager.addItem(chosen, savedQty);
          highlightProduct(chosen.id);
          lastIntentContext = null;
          await nova(`Great choice! Added ${savedQty} ${chosen.name} to your order. Anything else?`);
          return;
        }
      }

      // Try name match within the listed products
      const nameMatch = NLU.extractFoodItem(text, products);
      if (nameMatch && nameMatch.type === 'product') {
        OrderManager.addItem(nameMatch.item, savedQty);
        highlightProduct(nameMatch.item.id);
        lastIntentContext = null;
        await nova(`Added ${savedQty} ${nameMatch.item.name} to your order! 🎉 Anything else?`);
        return;
      }
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────────
    if (intent === 'CONFIRM') {
      if (state === STATES.CONFIRMING || lastIntentContext?.type === 'confirming') {
        await placeOrder();
        return;
      }
      const cart = OrderManager.getCart();
      if (cart.length === 0) {
        await nova(randomResponse('CART_EMPTY'));
        return;
      }
      lastIntentContext = { type: 'confirming' };
      state = STATES.CONFIRMING;
      const summary = OrderManager.cartSummaryText();
      const total = OrderManager.getTotal().toFixed(2);
      await nova(`Your order: ${summary}. Total is ₹${total}. Shall I confirm and send this to the kitchen?`);
      return;
    }

    // ── DONE (trigger confirmation flow) ─────────────────────────────────────
    if (intent === 'DONE') {
      const cart = OrderManager.getCart();
      if (cart.length === 0) {
        await nova("You haven't added anything yet! What would you like to order?");
        return;
      }
      lastIntentContext = { type: 'confirming' };
      state = STATES.CONFIRMING;
      const summary = OrderManager.cartSummaryText();
      await nova(`Your order is: ${summary}. Total is ₹${OrderManager.getTotal().toFixed(2)}. Should I place this order?`);
      return;
    }

    // ── CANCEL ────────────────────────────────────────────────────────────────
    if (intent === 'CANCEL') {
      if (lastIntentContext?.type === 'confirming') {
        lastIntentContext = null;
        state = STATES.IDLE;
        await nova("No problem! You can keep adding items. What else would you like?");
        return;
      }
      OrderManager.clear();
      lastIntentContext = null;
      await nova("Order cleared! Let's start fresh. What would you like to order?");
      return;
    }

    // ── INCREASE QTY ──────────────────────────────────────────────────────────
    if (intent === 'INCREASE_QTY') {
      const cart = OrderManager.getCart();
      if (cart.length && lastIntentContext?.item) {
        OrderManager.addItem(lastIntentContext.item, 1);
        await nova(`Added one more ${lastIntentContext.item.name}. Anything else?`);
      } else if (cart.length) {
        const last = cart[cart.length - 1];
        OrderManager.updateQty(last.id, 1);
        await nova(`Added one more ${last.name}. Anything else?`);
      } else {
        await nova("What would you like to add more of?");
      }
      return;
    }

    // ── FALLBACK ──────────────────────────────────────────────────────────────
    // If something was said but we don't understand, be helpful
    const cartItems = OrderManager.getCart();
    if (cartItems.length > 0) {
      await nova(`I didn't catch that. You have ${OrderManager.cartSummaryText()} in your cart. Say 'confirm' to place the order, or tell me what else you'd like!`);
    } else {
      await nova(randomResponse('UNKNOWN'));
    }
  }

  // ─── Place Order ─────────────────────────────────────────────────────────────
  async function placeOrder() {
    try {
      setStatus('Placing order...', '');
      const order = await OrderManager.submitOrder();
      lastIntentContext = null;
      state = STATES.IDLE;
      showSuccessModal(order);
      await nova(`Order confirmed! Your order ID is ${order.orderId}. It's on its way to the kitchen! 🎉`);
    } catch (err) {
      console.error('[Order] Failed:', err);
      await nova("I'm sorry, there was an issue placing your order. Please try again.");
    }
  }

  // ─── Success Modal ───────────────────────────────────────────────────────────
  function showSuccessModal(order) {
    const modal = document.getElementById('successModal');
    document.getElementById('modalOrderId').textContent = `Order #${order.orderId}`;
    document.getElementById('modalItems').innerHTML = order.items.map(i => `
      <div class="modal-item-row">
        <span>${i.emoji || ''} ${i.name} × ${i.quantity}</span>
        <span>₹${(i.price * i.quantity).toFixed(2)}</span>
      </div>
    `).join('');
    document.getElementById('modalTotal').textContent = `Total: ₹${order.total.toFixed(2)}`;
    modal.classList.add('visible');
  }

  function showConfirmModal() {
    const cart = OrderManager.getCart();
    if (cart.length === 0) return;
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmModalItems').innerHTML = cart.map(i => `
      <div class="modal-item-row">
        <span>${i.emoji || ''} ${i.name} × ${i.quantity}</span>
        <span>₹${(i.price * i.quantity).toFixed(2)}</span>
      </div>
    `).join('');
    document.getElementById('confirmModalTotal').textContent = `Total: ₹${OrderManager.getTotal().toFixed(2)}`;
    modal.classList.add('visible');
  }

  // ─── Menu UI Helpers ──────────────────────────────────────────────────────────
  function highlightProduct(productId) {
    const el = document.querySelector(`[data-product-id="${productId}"]`);
    if (el) {
      el.classList.add('highlighted');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => el.classList.remove('highlighted'), 2000);
    }
  }

  function highlightProducts(products) {
    products.forEach(p => {
      const el = document.querySelector(`[data-product-id="${p.id}"]`);
      if (el) {
        el.classList.add('highlighted');
        setTimeout(() => el.classList.remove('highlighted'), 3000);
      }
    });
  }

  function filterMenuByCategory(categoryId) {
    document.querySelectorAll('.cat-tab').forEach(t => t.classList.toggle('active', t.dataset.id == categoryId || (categoryId === 'all' && t.dataset.id === 'all')));
    const filtered = Menu.filterProducts(categoryId);
    renderMenuGrid(filtered);
  }

  // ─── Speech Recognition ───────────────────────────────────────────────────────
  function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { console.warn('[SR] Speech Recognition not supported'); return null; }

    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 3;

    rec.onstart = () => {
      state = STATES.LISTENING;
      setStatus('Listening...', 'listening');
      setMicState(true);
      setAvatarState('listening');
      setVADBadge('🔴 Speech Detected', true);
    };

    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      if (interim) updateTranscript(interim, true);
      if (final) {
        interimTranscript = final;
        updateTranscript(final, false);
        addMessage(final, 'user');
      }
    };

    rec.onend = () => {
      setMicState(false);
      setAvatarState('');
      setVADBadge('FireRedVAD Ready', false);
      setStatus('Processing...', '');
      if (interimTranscript) {
        const text = interimTranscript.trim();
        interimTranscript = '';
        handleIntent(text);
      } else {
        state = STATES.IDLE;
        setStatus('Ready', 'ready');
      }
    };

    rec.onerror = (e) => {
      console.error('[SR] Error:', e.error);
      setMicState(false);
      setAvatarState('');
      state = STATES.IDLE;
      setStatus('Ready', 'ready');
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        addMessage(`⚠️ Recognition error: ${e.error}. Please try again.`, 'assistant');
      }
    };

    return rec;
  }

  // ─── Mic Button Toggle ─────────────────────────────────────────────────────
  function toggleListening() {
    if (TTS.isActive()) {
      TTS.stop();
      state = STATES.IDLE;
    }

    if (state === STATES.LISTENING) {
      if (recognition) recognition.stop();
      vadActive = false;
      return;
    }

    if (state !== STATES.IDLE) return;

    interimTranscript = '';
    recognition = initSpeechRecognition();
    if (recognition) {
      try { recognition.start(); }
      catch (e) { console.error('[SR] start error', e); }
    } else {
      addMessage('⚠️ Speech recognition is not supported in this browser. Please use Chrome or Edge.', 'assistant');
    }
  }

  // ─── Init VAD ──────────────────────────────────────────────────────────────
  async function initVAD() {
    try {
      vad = new FireRedVAD({
        energyThreshold: 0.003,
        zcrThreshold: 0.18,
        silenceFrames: 25,
        speechFrames: 3,
      });
      await vad.init();

      vad.onVolumeUpdate = (volume) => {
        // Update VAD bars height dynamically
        const bars = document.querySelectorAll('#vadBars span');
        bars.forEach((bar, i) => {
          const factor = Math.sin((i / bars.length) * Math.PI) * volume;
          bar.style.height = `${4 + factor * 18}px`;
        });
      };

      vad.onSpeechStart = () => {
        console.log('[FireRedVAD] Speech start detected');
        setVADBadge('🔴 Speech Detected', true);
        // Auto-start recognition on speech detection
        if (state === STATES.IDLE && !vadActive) {
          vadActive = true;
          interimTranscript = '';
          recognition = initSpeechRecognition();
          if (recognition) {
            try { recognition.start(); }
            catch (e) { console.warn('[SR] auto-start error:', e); }
          }
        }
      };

      vad.onSpeechEnd = () => {
        console.log('[FireRedVAD] Speech end detected');
        setVADBadge('FireRedVAD Ready', false);
        vadActive = false;
      };

      console.log('[FireRedVAD] VAD active');
      return true;
    } catch (err) {
      console.warn('[FireRedVAD] Could not init (no mic permission?):', err);
      return false;
    }
  }

  // ─── Menu Rendering ────────────────────────────────────────────────────────
  function renderMenuGrid(products) {
    const grid = document.getElementById('menuGrid');
    if (!grid) return;
    if (!products || products.length === 0) {
      grid.innerHTML = '<div class="no-results">No items found 😕</div>';
      return;
    }
    grid.innerHTML = products.map(p => `
      <div class="menu-item-card" data-product-id="${p.id}" onclick="VoiceAssistant.quickAddProduct('${p.id}')" title="${p.name}">
        <button class="item-add-btn" aria-label="Add ${p.name}">+</button>
        <span class="item-emoji">${p.emoji}</span>
        <div class="item-name">${p.name}</div>
        <div class="item-category">${p.category}</div>
        <div class="item-price">₹${p.price.toFixed(2)}</div>
      </div>
    `).join('');
  }

  function renderCategories(categories) {
    const list = document.getElementById('categoriesList');
    if (!list) return;
    const allBtn = list.querySelector('[data-id="all"]');
    if (!allBtn) {
      list.innerHTML = '<button class="cat-tab active" data-id="all">All Items</button>';
    }
    categories.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'cat-tab';
      btn.dataset.id = cat.id;
      btn.textContent = cat.name;
      btn.addEventListener('click', () => filterMenuByCategory(cat.id));
      list.appendChild(btn);
    });
    list.querySelector('[data-id="all"]').addEventListener('click', () => filterMenuByCategory('all'));
  }

  function quickAddProduct(productId) {
    const product = Menu.getAll().find(p => p.id == productId);
    if (product) {
      OrderManager.addItem(product, 1);
      nova(`Added ${product.name} to your cart! 🎉`);
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  async function init() {
    setStatus('Loading menu...', '');
    TTS.init();

    // Load menu data
    const { categories, products } = await Menu.load();
    renderCategories(categories);
    renderMenuGrid(products);
    setStatus('Requesting microphone...', '');

    // Init VAD (requests mic permission)
    const vadOk = await initVAD();

    if (vadOk) {
      setStatus('Ready — VAD Active', 'ready');
      addMessage('🎙️ Microphone and FireRedVAD are active! I\'ll automatically detect when you start speaking.', 'assistant');
    } else {
      setStatus('Ready (manual mic)', 'ready');
      addMessage('⚠️ Microphone auto-detection unavailable. Please click the mic button to speak.', 'assistant');
    }

    // Mic button
    document.getElementById('micBtn').addEventListener('click', toggleListening);

    // Clear conversation
    document.getElementById('clearBtn').addEventListener('click', () => {
      const box = document.getElementById('conversationBox');
      box.innerHTML = '';
      addMessage("Conversation cleared! What would you like to order?", 'assistant');
      updateTranscript('');
    });

    // Order confirm button
    document.getElementById('confirmOrderBtn').addEventListener('click', () => {
      if (OrderManager.getCart().length === 0) return;
      showConfirmModal();
    });

    // Clear order
    document.getElementById('clearOrderBtn').addEventListener('click', () => {
      OrderManager.clear();
      nova("Cart cleared! What would you like to order?");
    });

    // Confirm modal
    document.getElementById('confirmYesBtn').addEventListener('click', async () => {
      document.getElementById('confirmModal').classList.remove('visible');
      await placeOrder();
    });
    document.getElementById('confirmNoBtn').addEventListener('click', () => {
      document.getElementById('confirmModal').classList.remove('visible');
    });

    // Success modal
    document.getElementById('modalCloseBtn').addEventListener('click', () => {
      document.getElementById('successModal').classList.remove('visible');
      addMessage("Order placed! 🎉 What would you like to order next?", 'assistant');
    });

    // Search
    const searchInput = document.getElementById('menuSearch');
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      const filtered = Menu.filterProducts(Menu.getActiveCategory(), q);
      renderMenuGrid(filtered);
    });

    // Greet after everything loads
    setTimeout(async () => {
      await nova("Welcome to TasteAI! I'm Nova, your personal food assistant. What would you like to order today? You can ask for biryani, burgers, pizza, and much more!");
    }, 1000);
  }

  return { init, quickAddProduct, toggleListening, filterMenuByCategory };
})();

// ─── Boot on DOM ready ────────────────────────────────────────────────────────
window.VoiceAssistant = VoiceAssistant;
document.addEventListener('DOMContentLoaded', () => VoiceAssistant.init());
