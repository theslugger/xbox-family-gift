'use strict';

/**
 * DisplayCatalog 查询 + 市场归一化
 * 与 userscript v3.9 的 pickAvail 逻辑保持一致
 */

const KNOWN_MARKETS = new Set([
  'AR','US','JP','TR','NG','BR','MX','CO','CL','PE','RU','UA','KZ','IN',
  'ID','MY','TH','VN','PH','EG','ZA','SA','AE','PL','HU','CZ','SK','RO',
  'BG','GR','PT','ES','IT','DE','FR','NL','BE','AT','CH','SE','NO','DK',
  'FI','IE','GB','CA','AU','NZ','SG','HK','TW','KR','CN','IL','QA','KW'
]);

const MARKET_LOCALE = {
  AR:'es-ar', US:'en-us', JP:'ja-jp', TR:'tr-tr', NG:'en-ng', BR:'pt-br',
  MX:'es-mx', CO:'es-co', CL:'es-cl', RU:'ru-ru', IN:'en-in', GB:'en-gb',
  CA:'en-ca', AU:'en-au', DE:'de-de', FR:'fr-fr', ES:'es-es', IT:'it-it',
  KR:'ko-kr', TW:'zh-tw', HK:'zh-hk', SG:'en-sg', NL:'nl-nl', PL:'pl-pl',
  SE:'sv-se', NO:'nb-no', DK:'da-dk', FI:'fi-fi', PT:'pt-pt', GR:'el-gr',
  CZ:'cs-cz', HU:'hu-hu', RO:'ro-ro', IL:'he-il', SA:'ar-sa', AE:'en-ae'
};

/** ES-AR / es-ar / es_AR / ZH-JP -> AR / JP ; 无法识别返回 '' */
function normMarket(v) {
  if (!v) return '';
  const s = String(v).toUpperCase().replace(/[^A-Z]/g, '');
  if (s.length === 2) return KNOWN_MARKETS.has(s) ? s : '';
  if (s.length === 4) {
    const tail = s.slice(2);
    if (KNOWN_MARKETS.has(tail)) return tail;
    const head = s.slice(0, 2);
    if (KNOWN_MARKETS.has(head)) return head;
  }
  return '';
}

function localeOf(mk) {
  return MARKET_LOCALE[normMarket(mk)] || 'en-us';
}

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();      // key -> {at, product}
const inflight = new Map();

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL) { cache.delete(k); return null; }
  return e.product;
}
function cacheSet(k, v) { cache.set(k, { at: Date.now(), product: v }); }

/**
 * 拉取商品原始数据（带缓存）
 */
async function fetchProduct(productId, market) {
  const mk = normMarket(market);
  if (!mk) throw new Error('无效市场码: ' + market);
  if (!/^[A-Z0-9]{12}$/i.test(productId || '')) throw new Error('无效 productId: ' + productId);

  const key = productId.toUpperCase() + '|' + mk;
  const hit = cacheGet(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const url = 'https://displaycatalog.mp.microsoft.com/v7.0/products/' +
    encodeURIComponent(productId) + '?market=' + encodeURIComponent(mk) +
    '&languages=' + encodeURIComponent(localeOf(mk)) + '&fieldsTemplate=Details';

  const p = (async () => {
    const r = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!r.ok) throw new Error('DisplayCatalog HTTP ' + r.status);
    const o = await r.json();
    const prod = o.Product || (o.Payload && o.Payload.Products && o.Payload.Products[0]);
    if (!prod) throw new Error('商品不存在于市场 ' + mk);
    cacheSet(key, prod);
    return prod;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

/**
 * 从商品数据里挑 availabilityId
 * 规则（与 userscript 一致）：
 *   1. 按 sku 过滤（若指定）
 *   2. 只取 ListPrice > 0 的条目，避开 0 价试用/免费
 *   3. 多个非零取第一个（标准档）
 *   4. 全为 0 时降级取第一个，保证结构完整
 */
function pickAvail(product, skuWanted) {
  const skus = product.DisplaySkuAvailabilities || [];
  let best = null;

  for (const a of skus) {
    const sku = a.Sku && a.Sku.SkuId;
    if (skuWanted && sku && sku !== skuWanted) continue;
    for (const av of (a.Availabilities || [])) {
      const aid = av.AvailabilityId;
      if (!aid) continue;
      const pr = (av.OrderManagementData || {}).Price || {};
      const list = Number(pr.ListPrice);
      if (isFinite(list) && list > 0) {
        best = {
          availabilityId: aid,
          skuId: sku,
          price: list,
          currency: pr.CurrencyCode || '',
          msrp: Number(pr.MSRP) || 0,
          isTrial: false
        };
        return best;   // 第一个有价即标准档
      }
    }
  }

  for (const a of skus) {
    const sku = a.Sku && a.Sku.SkuId;
    if (skuWanted && sku && sku !== skuWanted) continue;
    for (const av of (a.Availabilities || [])) {
      if (!av.AvailabilityId) continue;
      const pr = (av.OrderManagementData || {}).Price || {};
      best = {
        availabilityId: av.AvailabilityId,
        skuId: sku,
        price: Number(pr.ListPrice) || 0,
        currency: pr.CurrencyCode || '',
        msrp: Number(pr.MSRP) || 0,
        isTrial: true
      };
      return best;
    }
  }
  return null;
}

/**
 * 解析某商品在某市场的完整信息
 */
async function resolve(productId, market, skuId) {
  const mk = normMarket(market);
  const product = await fetchProduct(productId, mk);
  const avail = pickAvail(product, skuId);
  if (!avail) throw new Error('该商品在 ' + mk + ' 市场无可售条目');

  const lp = (product.LocalizedProperties || [])[0] || {};
  return {
    productId: product.ProductId || productId.toUpperCase(),
    productKind: product.ProductKind || '',
    title: lp.ProductTitle || lp.ShortTitle || '',
    publisher: lp.PublisherName || '',
    market: mk,
    skuId: avail.skuId,
    availabilityId: avail.availabilityId,
    price: avail.price,
    currency: avail.currency,
    msrp: avail.msrp,
    isTrial: avail.isTrial
  };
}

/**
 * 商品系列浏览（列表接口）：返回候选 productId + 是否有可购买动作
 * 注意：列表里的 Availabilities 不含 AvailabilityId，必须再走 resolve 拿详情
 */
async function browseFamily(market, opts = {}) {
  const mk = normMarket(market);
  if (!mk) throw new Error('无效市场码');

  const family = opts.family || 'games';
  const skip = Math.max(Number(opts.skip) || 0, 0);
  // 分页参数是 $skip（OData 风格），其他写法一律无效
  const url = 'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/' +
    encodeURIComponent(family) + '/products?market=' + encodeURIComponent(mk) +
    '&languages=' + encodeURIComponent(localeOf(mk)) +
    '&MS-CV=xfg' + (skip ? '&$skip=' + skip : '');

  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('catalog browse HTTP ' + r.status);
  const o = await r.json();
  return { products: o.Products || [], hasMore: !!o.HasMorePages, total: o.TotalResultCount || 0 };
}

/** 从列表条目里判断「可在该市场购买且非零价」 */
function listEntryPurchasable(p) {
  let best = 0;
  for (const a of (p.DisplaySkuAvailabilities || [])) {
    for (const av of (a.Availabilities || [])) {
      const acts = av.Actions || [];
      if (!acts.includes('Purchase')) continue;
      const pr = (av.OrderManagementData || {}).Price || {};
      const list = Number(pr.ListPrice) || 0;
      if (list > 0) best = Math.max(best, list);
    }
  }
  return best;
}

/**
 * 找出市场上可用的游戏（用于"狸猫换太子"）
 * 两阶段：列表筛候选 -> 详情拿 availabilityId
 * 排除已用过的 productId，保证每次都是新游戏
 */
async function findGames(market, opts = {}) {
  const mk = normMarket(market);
  if (!mk) throw new Error('无效市场码');

  const want = Math.min(Math.max(opts.count || 5, 1), 20);
  const exclude = new Set((opts.exclude || []).map(s => String(s).toUpperCase()));
  const maxPrice = Number(opts.maxPrice) || Infinity;
  const minPrice = Number(opts.minPrice) || 1;      // 默认排除 0 价（免费/试用）
  const maxScan = Math.min(Number(opts.maxScan) || 120, 400);

  const candidates = [];
  const seen = new Set(exclude);
  let skip = 0;
  let scanned = 0;

  while (scanned < maxScan) {
    let page;
    try { page = await browseFamily(mk, { family: opts.family, skip }); }
    catch (e) { break; }
    if (!page.products.length) break;

    for (const p of page.products) {
      scanned++;
      const pid = p.ProductId;
      if (!pid) continue;
      const key = String(pid).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if ((p.ProductKind || '') !== 'Game') continue;
      const price = listEntryPurchasable(p);
      if (price < minPrice || price > maxPrice) continue;
      // 优先挑便宜的，降低误扣风险
      candidates.push({ productId: pid, listPrice: price });
    }
    if (!page.hasMore) break;
    skip += page.products.length;
    if (candidates.length >= want * 6) break;
  }

  candidates.sort((a, b) => a.listPrice - b.listPrice);

  const out = [];
  const picked = new Set();
  for (const c of candidates) {
    if (out.length >= want) break;
    if (picked.has(c.productId.toUpperCase())) continue;
    try {
      const info = await resolve(c.productId, mk);
      if (info.productKind !== 'Game') continue;
      if (info.isTrial || info.price < minPrice) continue;
      if (info.price > maxPrice) continue;
      if (exclude.has(info.productId.toUpperCase())) continue;
      if (picked.has(info.productId.toUpperCase())) continue;
      if (!info.availabilityId) continue;
      picked.add(info.productId.toUpperCase());
      out.push(info);
    } catch (e) { /* 不可售/已下架，跳过 */ }
  }
  return out;
}

module.exports = { normMarket, localeOf, resolve, findGames, browseFamily, fetchProduct, pickAvail, MARKET_LOCALE };
