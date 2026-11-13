/**
 * ============================================================
 * swap_payment.js —— 主号 family safety 付款阶段：把整条链一致换成内购
 * ------------------------------------------------------------
 * 报错 "something went wrong" 的根因(真实 HAR 2026-11 验证):
 *   只换 buynow 的 productId，但 availabilityId 仍是游戏的,
 *   且付款页商品详情(#family/api/product bigId=游戏) 仍显示游戏名/图,
 *   订单(orders)也是游戏 -> 订单/展示/购买三者不一致 => 服务端报错。
 *
 * 所以必须在【主号 safety 付款阶段】把三处一起、且一致地换成内购:
 *   1) 收款建单:  POST purchase.md.mp.microsoft.com/vX.Y/users/me/orders
 *                 body.items[].productId/skuId/availabilityId -> 内购
 *   2) 付款页商品详情: GET account.microsoft.com/family/api/product?bigId=<游戏>/<sku>
 *                 URL 里 bigId -> 内购/<内购sku>  (名称/图片才会变成内购的)
 *   3) 确认购买页: POST www.microsoft.com/store/purchase/buynowui/buynow
 *                 form products=[{productId,skuId,availabilityId}] -> 内购
 *                 (仅 callerApplicationId=AMCFamilySafetyApp / scenario=parentApproval)
 *
 * 不碰: 子号 RequestParentalApproval / loadCart / approve 本身
 * 数据: 本地 idsGame / idsIAP(含 productId+availabilityId+skuId)
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";
function load(k) { try { return JSON.parse($persistentStore.read(k)); } catch (e) { return null; } }
function q(s) { return encodeURIComponent(s); }
function unq(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function swapOne(o, g, t) {
  // 一致替换: productId 命中游戏 -> 内购; sku 命中 -> 内购; avail 命中游戏或为空 -> 内购
  var n = 0;
  if (o.productId === g.productId) { o.productId = t.productId; n++; }
  if (o.skuId !== undefined && g.skuId && o.skuId === g.skuId && t.skuId) { o.skuId = t.skuId; n++; }
  if (o.availabilityId !== undefined) {
    if ((g.availabilityId && o.availabilityId === g.availabilityId) || o.availabilityId === "") {
      if (t.availabilityId) { o.availabilityId = t.availabilityId; n++; }
    }
  }
  return n;
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }
  var url = $request.url || "";

  var g = load(GAME_KEY), t = load(IAP_KEY);
  if (!g || !t) { $done({}); return; }
  if (!t.availabilityId) {
    $notification.post("⚠️ 内购 availabilityId 缺失", "请重新加购内购以采集", "当前只有 productId=" + t.productId);
    // 仍继续(尽量替换 productId)
  }

  // ===== 1) 收款建单 orders =====
  if (/purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/.test(url)) {
    var body = $request.body; if (!body) { $done({}); return; }
    var o; try { o = JSON.parse(body); } catch (e) { $done({}); return; }
    var n = 0;
    (function walk(x) {
      if (x === null || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x.productId === g.productId) n += swapOne(x, g, t);
      for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
    })(o);
    if (n > 0) { $notification.post("✅ 订单商品已换内购", t.productId, "字段:" + n); $done({ body: JSON.stringify(o) }); }
    else $done({});
    return;
  }

  // ===== 2) family/api/product 是【审批页展示】= 必须保持游戏, 绝不替换 =====
  //   (V4 曾把这里改成内购, 导致审批页变成"充值金币", 主号批准的不是游戏 -> 错误)
  //   直接放行, 不处理。

  // ===== 3) 确认购买页 buynow (仅 safety) =====
  if (/www\.microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url)) {
    var b2 = $request.body; if (!b2) { $done({}); return; }
    // 解析 form
    var d = {};
    b2.split("&").forEach(function (p) {
      var i = p.indexOf("="); if (i < 0) return;
      d[unq(p.slice(0, i))] = p.slice(i + 1);
    });
    var caller = d["callerApplicationId"] ? unq(d["callerApplicationId"]) : "";
    var scen = d["scenario"] ? unq(d["scenario"]) : "";
    if (caller !== "AMCFamilySafetyApp" && scen !== "parentApproval") { $done({}); return; } // 子号不碰
    if (d["products"] === undefined) { $done({}); return; }
    var arr; try { arr = JSON.parse(unq(d["products"])); } catch (e) { $done({}); return; }
    if (!Array.isArray(arr)) { $done({}); return; }
    var cn = 0; arr.forEach(function (it) { cn += swapOne(it, g, t); });
    if (cn === 0) { $done({}); return; }
    var parts = [];
    b2.split("&").forEach(function (p) {
      var i = p.indexOf("="); if (i < 0) { parts.push(p); return; }
      var k = unq(p.slice(0, i));
      if (k === "products") parts.push(p.slice(0, i) + "=" + q(JSON.stringify(arr)));
      else parts.push(p);
    });
    $notification.post("✅ safety购买页已换内购", t.productId + " · sku " + t.skuId, "字段:" + cn);
    $done({ body: parts.join("&") });
    return;
  }

  $done({});
})();
