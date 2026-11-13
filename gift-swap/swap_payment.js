/**
 * ============================================================
 * swap_payment.js —— 主号在 family safety 最终付款/审批时，
 *                    把"游戏"换成"内购"
 * ------------------------------------------------------------
 * 基于真实抓包(HAR)校准的替换点（微软 2026-11 实测）：
 *
 *  1) 主号点"批准购买":
 *     POST https://account.microsoft.com/family/api/buy/requests/approve
 *     body(JSON): {"onBehalfOfPuid","orderId","productId","skuId"}
 *     -> 把 productId/skuId 换成内购
 *
 *  2) 主号确认购买页(iframe):
 *     POST https://www.microsoft.com/store/purchase/buynowui/buynow
 *     body(form-urlencoded): products=[{"productId","skuId","availabilityId"}]
 *     -> 把 products= 里的 productId/skuId/availabilityId 换成内购
 *
 *  3) 子号下单(如需):
 *     POST https://purchase.md.mp.microsoft.com/v7.0/users/me/orders
 *     body(JSON): items:[{availabilityId,productId,skuId,...}]
 *     -> 替换 items[].productId/skuId/availabilityId
 *
 *  4) 老版授权接口(若出现):
 *     POST https://purchase.mp.microsoft.com/v7.0/purchases/grant
 *     body(JSON): {availabilityId,productId,skuId,...}
 *
 * 数据来源: 本地存储 idsGame / idsIAP（由 capture_ids.js 采集）
 *   —— 若采集顺序不可靠，可直接手写这两个键。
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";

function load(k) { try { return JSON.parse($persistentStore.read(k)); } catch (e) { return null; } }
function q(s) { return encodeURIComponent(s); }
function unq(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

// 替换一个 "对象内" 的 productId/skuId/availabilityId
function swapFields(o, game, iap, counter) {
  if (o.productId === game.productId) { o.productId = iap.productId; counter.n++; }
  if (game.skuId && o.skuId === game.skuId) { o.skuId = iap.skuId; counter.n++; }
  if (game.availabilityId && iap.availabilityId && o.availabilityId === game.availabilityId) {
    o.availabilityId = iap.availabilityId; counter.n++;
  }
}

function swapJSON(text, game, iap) {
  var obj;
  try { obj = JSON.parse(text); } catch (e) { return null; }
  var counter = { n: 0 };
  (function walk(x) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i]); return; }
    swapFields(x, game, iap, counter);
    for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
  })(obj);
  if (counter.n === 0) return null;
  return { body: JSON.stringify(obj), n: counter.n };
}

// 处理 buynow 的 form-urlencoded：products=[{productId,skuId,availabilityId}]
function swapForm(text, game, iap) {
  var counter = { n: 0 };
  var parts = text.split("&").map(function (pair) {
    var idx = pair.indexOf("=");
    if (idx < 0) return pair;
    var k = pair.slice(0, idx), v = pair.slice(idx + 1);
    if (k === "products") {
      var raw = unq(v), arr;
      try { arr = JSON.parse(raw); } catch (e) { return pair; }
      if (Array.isArray(arr)) {
        arr.forEach(function (it) { swapFields(it, game, iap, counter); });
        return k + "=" + q(JSON.stringify(arr));
      }
    }
    return pair;
  });
  if (counter.n === 0) return null;
  return { body: parts.join("&"), n: counter.n };
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }
  var url = $request.url || "";

  var TARGET =
    /account\.microsoft\.com\/family\/api\/buy\/requests\/approve/.test(url) ||
    /microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url) ||
    /purchase\.md\.mp\.microsoft\.com\/.*\/users\/me\/orders/.test(url) ||
    /purchase\.mp\.microsoft\.com\/.*\/purchases\/grant/.test(url);
  if (!TARGET) { $done({}); return; }

  var game = load(GAME_KEY), iap = load(IAP_KEY);
  if (!game || !iap) {
    $notification.post("未替换", "缺少 idsGame/idsIAP", "请先按顺序加购: 游戏→内购");
    $done({});
    return;
  }
  var body = $request.body;
  if (!body) { $done({}); return; }

  // 1) 尝试 JSON（approve / orders / grant）
  var r = swapJSON(body, game, iap);
  if (r) {
    $notification.post("已替换为内购(JSON)", url.split("/").pop().slice(0, 40), "字段数:" + r.n);
    $done({ body: r.body });
    return;
  }

  // 2) 尝试 form-urlencoded（buynow products=）
  if (body.indexOf("products=") !== -1) {
    var f = swapForm(body, game, iap);
    if (f) {
      $notification.post("已替换为内购(表单)", "buynow products[]", "字段数:" + f.n);
      $done({ body: f.body });
      return;
    }
  }

  // 3) 兜底：仅文本替换出现的 game.productId
  if (body.indexOf(game.productId) !== -1) {
    var out = body.split(game.productId).join(iap.productId);
    $notification.post("已替换为内购(文本兜底)", iap.productId, "");
    $done({ body: out });
    return;
  }

  $done({ body: body });
})();
