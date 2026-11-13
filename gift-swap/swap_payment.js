/**
 * ============================================================
 * swap_payment.js —— 只在"确认付款页点购买"时，把游戏换成内购
 * ------------------------------------------------------------
 * 基于真实 HAR(2026-11)校准：
 *
 *  主号在 family safety 审批后，会进入"确认购买"页；在页面上点
 *  【购买】这一刻，客户端发出真正带商品 ID 的结算请求：
 *
 *   A) 建订单(真正决定买什么 / 扣款金额):
 *      POST https://purchase.md.mp.microsoft.com/v\d+\.\d+/users/me/orders
 *      body(JSON): {"orderId","items":[{"availabilityId","productId","skuId","quantity","beneficiary"}]}
 *      —— 这是"购买"点下去的真实订单，商品=游戏，需换成内购。
 *
 *   B) 确认购买页 iframe:
 *      POST https://www.microsoft.com/store/purchase/buynowui/buynow
 *      form: products=[{"productId","skuId","availabilityId"}]
 *
 *   C) 授权(如出现):
 *      POST https://purchase.mp.microsoft.com/v\d+\.\d+/purchases/grant
 *      body(JSON): {availabilityId,productId,skuId,...}
 *
 *  ⚠️ 明确【不碰】的请求（避免"过早替换"）：
 *     - account.microsoft.com/family/api/buy/requests/approve  (只是登记核准)
 *     - cart.production.../loadCart / addItems                   (子号加购)
 *     - 子号发起购买前产生的任何请求
 *
 * 数据来源: 本地存储 idsGame / idsIAP（capture_ids.js 采集）
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";
function load(k) { try { return JSON.parse($persistentStore.read(k)); } catch (e) { return null; } }
function q(s) { return encodeURIComponent(s); }
function unq(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function swapFields(o, game, iap, counter) {
  if (o.productId === game.productId) { o.productId = iap.productId; counter.n++; }
  if (game.skuId && o.skuId === game.skuId) { o.skuId = iap.skuId; counter.n++; }
  if (game.availabilityId && iap.availabilityId && o.availabilityId === game.availabilityId) {
    o.availabilityId = iap.availabilityId; counter.n++;
  }
}
function swapJSON(text, game, iap) {
  var obj; try { obj = JSON.parse(text); } catch (e) { return null; }
  var counter = { n: 0 };
  (function walk(x) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i]); return; }
    swapFields(x, game, iap, counter);
    for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
  })(obj);
  return counter.n ? { body: JSON.stringify(obj), n: counter.n } : null;
}
function swapForm(text, game, iap) {
  var counter = { n: 0 };
  var parts = text.split("&").map(function (pair) {
    var idx = pair.indexOf("=");
    if (idx < 0) return pair;
    var k = pair.slice(0, idx), v = pair.slice(idx + 1);
    if (k === "products") {
      var arr; try { arr = JSON.parse(unq(v)); } catch (e) { return pair; }
      if (Array.isArray(arr)) {
        arr.forEach(function (it) { swapFields(it, game, iap, counter); });
        return k + "=" + q(JSON.stringify(arr));
      }
    }
    return pair;
  });
  return counter.n ? { body: parts.join("&"), n: counter.n } : null;
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }
  var url = $request.url || "";

  // 只命中"最终购买/结算"三个请求；approve、loadCart 等一律放行
  var isOrders = /purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/.test(url);
  var isBuynow = /www\.microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url);
  var isGrant  = /purchase\.mp\.microsoft\.com\/v\d+\.\d+\/purchases\/grant/.test(url);
  if (!(isOrders || isBuynow || isGrant)) { $done({}); return; }

  var game = load(GAME_KEY), iap = load(IAP_KEY);
  if (!game || !iap) { $notification.post("未替换", "缺少 idsGame/idsIAP", "请先加购: 游戏→内购"); $done({}); return; }
  var body = $request.body;
  if (!body) { $done({}); return; }

  var r = swapJSON(body, game, iap);
  if (r) { $notification.post("付款已替换为内购(JSON)", url.split("/").pop().slice(0, 32), "字段:" + r.n); $done({ body: r.body }); return; }

  if (isBuynow && body.indexOf("products=") !== -1) {
    var f = swapForm(body, game, iap);
    if (f) { $notification.post("付款已替换为内购(buynow表单)", "products[]", "字段:" + f.n); $done({ body: f.body }); return; }
  }

  // 兜底：文本替换 game.productId（仅 orders/buynow/grant 命中时）
  if (body.indexOf(game.productId) !== -1) {
    $done({ body: body.split(game.productId).join(iap.productId) });
    return;
  }
  $done({ body: body });
})();
