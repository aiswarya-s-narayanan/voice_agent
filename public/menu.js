/**
 * menu.js — Menu data fetching & management
 * Fetches categories and products from the backend API proxy.
 * Exposes a global `Menu` object used by app.js
 */

const Menu = (() => {
  // ─── State ───────────────────────────────────────────────────────────────
  let categories = [];
  let allProducts = [];
  let filteredProducts = [];
  let activeCategory = 'all';
  let searchQuery = '';
  let onReadyCallback = null;

  // ─── Emoji Map (by category/product name keywords) ────────────────────────
  const EMOJI_MAP = [
    { keys: ['biryani', 'biriyani', 'rice'], emoji: '🍛' },
    { keys: ['burger', 'burger'], emoji: '🍔' },
    { keys: ['pizza'], emoji: '🍕' },
    { keys: ['chicken'], emoji: '🍗' },
    { keys: ['mutton', 'lamb'], emoji: '🥩' },
    { keys: ['fish', 'prawn', 'seafood', 'shrimp'], emoji: '🐟' },
    { keys: ['noodle', 'pasta', 'spaghetti'], emoji: '🍜' },
    { keys: ['wrap', 'shawarma', 'roll'], emoji: '🌯' },
    { keys: ['sandwich', 'sub'], emoji: '🥪' },
    { keys: ['soup', 'shorba'], emoji: '🍲' },
    { keys: ['salad'], emoji: '🥗' },
    { keys: ['dessert', 'cake', 'sweet', 'gulab', 'halwa', 'kheer'], emoji: '🍰' },
    { keys: ['ice cream', 'gelato'], emoji: '🍦' },
    { keys: ['drink', 'juice', 'smoothie', 'lassi', 'shake'], emoji: '🥤' },
    { keys: ['tea', 'chai'], emoji: '☕' },
    { keys: ['coffee'], emoji: '☕' },
    { keys: ['water', 'soda', 'soft drink'], emoji: '💧' },
    { keys: ['dosa', 'idli', 'vada', 'sambar'], emoji: '🫓' },
    { keys: ['paneer'], emoji: '🧀' },
    { keys: ['dal', 'curry', 'gravy'], emoji: '🥘' },
    { keys: ['roti', 'naan', 'bread', 'paratha'], emoji: '🫓' },
    { keys: ['tandoori'], emoji: '🔥' },
    { keys: ['snack', 'fries', 'chips'], emoji: '🍟' },
    { keys: ['egg'], emoji: '🥚' },
    { keys: ['starter', 'appetizer'], emoji: '🍱' },
    { keys: ['steak'], emoji: '🥩' },
    { keys: ['hotdog', 'hot dog'], emoji: '🌭' },
    { keys: ['taco'], emoji: '🌮' },
    { keys: ['sushi'], emoji: '🍣' },
  ];

  function getEmoji(name = '', categoryName = '') {
    const text = (name + ' ' + categoryName).toLowerCase();
    for (const { keys, emoji } of EMOJI_MAP) {
      if (keys.some(k => text.includes(k))) return emoji;
    }
    return '🍽️';
  }

  // ─── API Calls ────────────────────────────────────────────────────────────
  async function fetchCategories() {
    const resp = await fetch('/api/categories');
    if (!resp.ok) throw new Error(`Categories API error: ${resp.status}`);
    const data = await resp.json();
    // Handle {success, data:[...]} shape from real API
    if (data && data.success && Array.isArray(data.data)) return data.data;
    return Array.isArray(data) ? data : (data.data || data.categories || data.result || []);
  }

  async function fetchProducts(params = {}) {
    const url = new URL('/api/products', location.origin);
    if (params.categoryId) url.searchParams.set('categoryId', params.categoryId);
    if (params.search) url.searchParams.set('search', params.search);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    // 401 or token expired — return empty so we fall back to demo data
    if (!resp.ok || data.success === false) {
      console.warn('[Menu] Products API issue:', data.message || resp.status);
      return [];
    }
    if (data && data.success && Array.isArray(data.data)) return data.data;
    return Array.isArray(data) ? data : (data.data || data.products || data.result || []);
  }

  // ─── Normalize a product object ───────────────────────────────────────────
  function normalizeProduct(p, categoryName = '') {
    const name = p.productName || p.name || p.title || 'Unknown Item';
    const catId = p.productCategoryId || p.categoryId || p.category_id || '';
    return {
      id:          p.productId || p.id || p._id || String(Math.random()),
      name,
      price:       parseFloat(p.sellingPrice || p.price || p.rate || 0),
      category:    p.categoryName || p.category || categoryName || 'Other',
      categoryId:  String(catId),
      description: p.description || p.desc || '',
      available:   p.isActive !== false && p.available !== false && p.status !== 'inactive',
      emoji:       getEmoji(name, p.categoryName || categoryName),
    };
  }

  // ─── Load All Data ────────────────────────────────────────────────────────
  async function load() {
    try {
      // 1. Categories
      const rawCats = await fetchCategories();
      categories = rawCats.map(c => ({
        id:   String(c.productCategoryId || c.id || c._id || c.categoryId || c.name),
        name: c.categoryName || c.name || c.title || 'Unknown',
      }));

      // 2. Products (all at once, then filter by category client-side)
      const rawProducts = await fetchProducts();

      if (rawProducts.length > 0) {
        allProducts = rawProducts.map(p => {
          const catId = String(p.productCategoryId || p.categoryId || '');
          const cat = categories.find(c => c.id === catId) || {};
          return normalizeProduct(p, cat.name);
        });
        filteredProducts = [...allProducts];
        console.log(`[Menu] Loaded ${categories.length} categories, ${allProducts.length} products from API`);
        return { categories, products: allProducts };
      } else {
        // Products not available (token issue etc) — use fallback products but real categories
        console.warn('[Menu] No products from API, using demo products');
        const fallback = loadFallbackData();
        // Merge real categories if we got them
        if (categories.length > 0) {
          fallback.categories = categories;
        }
        return fallback;
      }
    } catch (err) {
      console.error('[Menu] Load error:', err);
      return loadFallbackData();
    }
  }

  // ─── Fallback Demo Data (if API unavailable) ──────────────────────────────
  function loadFallbackData() {
    console.warn('[Menu] Using fallback demo data');
    categories = [
      { id: '1', name: 'Biryani' },
      { id: '2', name: 'Burgers' },
      { id: '3', name: 'Pizza' },
      { id: '4', name: 'Beverages' },
      { id: '5', name: 'Desserts' },
    ];
    allProducts = [
      { id: 'p1', name: 'Chicken Dum Biryani', price: 220, category: 'Biryani', categoryId: '1', emoji: '🍛', available: true },
      { id: 'p2', name: 'Mutton Biryani', price: 280, category: 'Biryani', categoryId: '1', emoji: '🍛', available: true },
      { id: 'p3', name: 'Veg Biryani', price: 160, category: 'Biryani', categoryId: '1', emoji: '🍛', available: true },
      { id: 'p4', name: 'Prawn Biryani', price: 320, category: 'Biryani', categoryId: '1', emoji: '🍛', available: true },
      { id: 'p5', name: 'Classic Beef Burger', price: 180, category: 'Burgers', categoryId: '2', emoji: '🍔', available: true },
      { id: 'p6', name: 'Crispy Chicken Burger', price: 160, category: 'Burgers', categoryId: '2', emoji: '🍔', available: true },
      { id: 'p7', name: 'Veg Burger', price: 120, category: 'Burgers', categoryId: '2', emoji: '🍔', available: true },
      { id: 'p8', name: 'Margherita Pizza', price: 250, category: 'Pizza', categoryId: '3', emoji: '🍕', available: true },
      { id: 'p9', name: 'Pepperoni Pizza', price: 320, category: 'Pizza', categoryId: '3', emoji: '🍕', available: true },
      { id: 'p10', name: 'BBQ Chicken Pizza', price: 340, category: 'Pizza', categoryId: '3', emoji: '🍕', available: true },
      { id: 'p11', name: 'Mango Lassi', price: 80, category: 'Beverages', categoryId: '4', emoji: '🥤', available: true },
      { id: 'p12', name: 'Fresh Lime Soda', price: 60, category: 'Beverages', categoryId: '4', emoji: '🥤', available: true },
      { id: 'p13', name: 'Chocolate Brownie', price: 120, category: 'Desserts', categoryId: '5', emoji: '🍰', available: true },
      { id: 'p14', name: 'Gulab Jamun', price: 80, category: 'Desserts', categoryId: '5', emoji: '🍰', available: true },
    ];
    filteredProducts = [...allProducts];
    return { categories, products: allProducts };
  }

  // ─── Filtering ────────────────────────────────────────────────────────────
  function filterProducts(categoryId = 'all', query = '') {
    activeCategory = categoryId;
    searchQuery = query;
    filteredProducts = allProducts.filter(p => {
      const matchCat = categoryId === 'all' || p.categoryId == categoryId;
      const matchQ = !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.category.toLowerCase().includes(query.toLowerCase());
      return matchCat && matchQ && p.available !== false;
    });
    return filteredProducts;
  }

  // ─── Search by name (for voice assistant) ─────────────────────────────────
  function searchByName(query) {
    const q = query.toLowerCase().trim();
    return allProducts.filter(p => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }

  function findByCategory(categoryQuery) {
    const q = categoryQuery.toLowerCase().trim();
    const cat = categories.find(c => c.name.toLowerCase().includes(q));
    if (!cat) return { category: null, products: [] };
    return {
      category: cat,
      products: allProducts.filter(p => p.categoryId == cat.id && p.available !== false),
    };
  }

  function getAll() { return allProducts; }
  function getFiltered() { return filteredProducts; }
  function getCategories() { return categories; }
  function getActiveCategory() { return activeCategory; }

  return { load, filterProducts, searchByName, findByCategory, getAll, getFiltered, getCategories, getActiveCategory, getEmoji };
})();
