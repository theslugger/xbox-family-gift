/**
 * ============================================================
 * capture_ids.js —— 采集"游戏"与"内购"两套商品 ID
 * ------------------------------------------------------------
 * 玩法(游戏掩护 + 付款换内购):
 *   1) 子号先把【游戏】加入购物车/发起家庭组购买 -> 本脚本记为 idsGame
 *   2) 子号再把【内购(金币)】加入购物车            -> 本脚本记为 idsIAP
 *   3) 主号在 family safety 审批"游戏"通过
 *   4) 走到付款时 swap_payment.js 把付款请求里的商品 ID 全换成 idsIAP
 *      -> 实付内购的钱, 子号拿到内购; 家庭安全审批的是游戏(掩护)。
 *
 * 触发: http-request (加购/发起购买), requires-body=1
 *   pattern: ^https://cart\.production\.store-web\.dynamics\.com/v\d+\.\d+/cart/loadCart
 *   （购物车 add 也会走 loadCart 或 addItems，视客户端而定，可再加一条）
 *
 * 取值: 请求体 itemsToAdd.items[0] 的 productId/availabilityId/skuId。
 *   第一次采集到 -> 存 "idsGame" (游戏)
 *   之后若出现不同商品 -> 存 "idsIAP" (内购)
 *
 * 手动覆盖: 若自动判定顺序不可靠，可直接在本地存储里手写
 *   idsGame / idsIAP (格式见下)，本脚本第 2 次起不再覆盖。
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";

function extractIds(body) {
  var o;
  try { o = JSON.parse(body); } catch (e) { return null; }
  if (!o) return null;

  // 常见: itemsToAdd.items[0]
  var cand = null;
  if (o.itemsToAdd && o.itemsToAdd.items && o.itemsToAdd.items.length) cand = o.itemsToAdd.items[0];
  else if (Array.isArray(o.items) && o.items.length) cand = o.items[0];
  else if (o.itemsToAdd && o.itemsToAdd.items) cand = null;

  if (!cand) return null;
  var pid = cand.productId || cand.ProductId;
  var aid = cand.availabilityId || cand.AvailabilityId;
  var sid = cand.skuId || cand.SkuId;
  if (!pid || !sid) return null; // availabilityId 有时缺，允许空
  return { productId: pid, availabilityId: aid || "", skuId: sid };
}

function sameId(a, b) {
  return a && b && a.productId === b.productId && a.skuId === b.skuId;
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }
  if (!$request.body) { $done({}); return; }

  var ids = extractIds($request.body);
  if (!ids) { $done({}); return; }

  var game = null, iap = null;
  try { game = JSON.parse($persistentStore.read(GAME_KEY)); } catch (e) {}
  try { iap  = JSON.parse($persistentStore.read(IAP_KEY)); } catch (e) {}

  if (!game) {
    $persistentStore.write(JSON.stringify(ids), GAME_KEY);
    $notification.post("已记录【游戏】ID", ids.productId, "sku:" + ids.skuId + " (此单为掩护, 家庭审批对象)");
    $done({});
    return;
  }
  if (!sameId(game, ids) && (!iap || !sameId(iap, ids))) {
    $persistentStore.write(JSON.stringify(ids), IAP_KEY);
    $notification.post("已记录【内购】ID", ids.productId, "sku:" + ids.skuId + " (付款时将替换为此)");
  }
  $done({});
})();
