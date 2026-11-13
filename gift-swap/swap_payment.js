/**
 * ============================================================
 * swap_payment.js —— 付款/授权阶段把商品 ID 换成内购
 * ------------------------------------------------------------
 * 关键: 家庭安全(family safety)审批的是【游戏】订单; 审批通过后,
 *       真正的付款在下面这些请求里, 请求体带 productId/skuId/
 *       availabilityId/orderLineItems[]. 在这一步把游戏 ID 全部替换
 *       成【内购】ID, 即"审批过的是游戏, 实付/入库的是内购"。
 *
 * 覆盖端点(按微软真实 API):
 *   - https://purchase.mp.microsoft.com/v\d+\.\d+/purchases/grant     (v7/v8 授权)
 *   - https://purchase.mp.microsoft.com/v\d+\.\d+/users/me/orders.*   (下单)
 *   - https://www.microsoft.com/store/purchase/buynowui/buynow        (Web 购买)
 *   - https://checkout.microsoft.com/... (若走 checkout 页)
 *
 * 触发: http-request, requires-body=1
 * 数据: 从本地存储读 idsGame / idsIAP (由 capture_ids.js 采集)
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";
var PAYMENT_PATTERN = /purchase\.mp\.microsoft\.com\/.*\/(purchases\/grant|users\/me\/orders)|microsoft\.com\/store\/purchase\/buynowui\/buynow|checkout\.microsoft\.com/i;

function load(k) {
  try { return JSON.parse($persistentStore.read(k)); } catch (e) { return null; }
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }

  var url = $request.url || "";
  if (!PAYMENT_PATTERN.test(url)) { $done({}); return; }

  var game = load(GAME_KEY);
  var iap = load(IAP_KEY);
  if (!game || !iap) {
    $notification.post("无法替换", "缺少已采集的游戏/内购 ID", "请先按顺序加购游戏与内购");
    $done({});
    return;
  }
  if (!$request.body) { $done({}); return; }

  // 用 JSON 精确替换(优先)，失败则整串文本替换
  var obj = null;
  try { obj = JSON.parse($request.body); } catch (e) { obj = null; }

  function swapObj(o) {
    var n = 0;
    (function walk(x) {
      if (x === null || typeof x !== "object") return;
      if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i]); return; }
      if (x.productId === game.productId) { x.productId = iap.productId; n++; }
      if (game.skuId && x.skuId === game.skuId) { x.skuId = iap.skuId; n++; }
      if (game.availabilityId && x.availabilityId === game.availabilityId && iap.availabilityId) {
        x.availabilityId = iap.availabilityId; n++;
      }
      for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
    })(o);
    return n;
  }

  if (obj && typeof obj === "object") {
    var changed = swapObj(obj);
    if (changed > 0) {
      $notification.post("付款 ID 已替换为内购", iap.productId + " / sku " + iap.skuId, "替换字段数: " + changed);
      $done({ body: JSON.stringify(obj) });
      return;
    }
    $done({ body: $request.body });
    return;
  }

  // 文本回退（保守：仅替换出现的 game.productId 与 game.skuId）
  var out = $request.body;
  try {
    if (game.productId) out = out.split(game.productId).join(iap.productId);
    if (game.skuId) out = out.split(game.skuId).join(iap.skuId);
  } catch (e) {}
  $notification.post("付款 ID 已替换(文本模式)", iap.productId, "");
  $done({ body: out });
})();
