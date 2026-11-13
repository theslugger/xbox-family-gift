/**
 * ============================================================
 * capture_ids.js —— 采集"游戏"与"内购"两套商品 ID（每次命中都弹窗）
 * ------------------------------------------------------------
 * 玩法(游戏掩护 + 付款换内购):
 *   1) 子号加购【游戏】   -> 记 idsGame，弹窗【第①次·游戏】
 *   2) 子号加购【内购】   -> 记 idsIAP ，弹窗【第②次·内购】
 *   3) 主号 family safety 审批游戏通过
 *   4) 确认购买页点【购买】-> swap_payment 把商品 ID 换成内购
 *
 * 弹窗规则（你要的）:
 *   - 第一次采集到的新商品 -> 记为游戏，弹 "①游戏已记录"
 *   - 第二次采集到的不同商品 -> 记为内购，弹 "②内购已记录"
 *   - 之后重复出现相同商品 -> 不再重复弹（避免刷屏）
 *   - 若想重置：在本地存储删掉 idsGame / idsIAP 即可
 *
 * 取值: 遍历请求体 itemsToAdd.items（或 items），逐条处理。
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";

// 兼容 Surge / Quantumult X / Shadowrocket 的弹窗
function notify(title, subtitle, body) {
  // 仅 Surge: $notification.post
  try { $notification.post(title, subtitle || "", body || ""); } catch (e) {}
}

function loadIds(k) { try { var v = $persistentStore.read(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function sameId(a, b) { return a && b && a.productId === b.productId && a.skuId === b.skuId; }

function collectItems(body) {
  var o; try { o = JSON.parse(body); } catch (e) { return []; }
  if (!o) return [];
  var arr = null;
  if (o.itemsToAdd && Array.isArray(o.itemsToAdd.items)) arr = o.itemsToAdd.items;
  else if (Array.isArray(o.items)) arr = o.items;
  if (!arr) return [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i] || {};
    var pid = it.productId || it.ProductId;
    var sid = it.skuId || it.SkuId;
    var aid = it.availabilityId || it.AvailabilityId || "";
    if (pid && sid) out.push({ productId: pid, availabilityId: aid, skuId: sid, _name: it.title || it.productTitle || "" });
  }
  return out;
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }
  if (!$request.body) { $done({}); return; }

  var items = collectItems($request.body);
  if (!items.length) { $done({}); return; }

  var game = loadIds(GAME_KEY);
  var iap = loadIds(IAP_KEY);
  var changed = false;

  for (var i = 0; i < items.length; i++) {
    var ids = items[i];
    if (game && sameId(game, ids)) continue;       // 已是游戏，跳过
    if (iap && sameId(iap, ids)) continue;          // 已是内购，跳过

    if (!game) {
      // 第①次：记为游戏
      $persistentStore.write(JSON.stringify(ids), GAME_KEY);
      game = ids; changed = true;
      console.log("XBOX-FAMILY: ①游戏ID已记录 " + JSON.stringify(ids));
      notify("①【游戏】已记录", ids.productId + (ids._name ? " · " + ids._name : ""),
        "avail:" + ids.availabilityId + " sku:" + ids.skuId);
    } else if (!iap) {
      // 第②次：记为内购
      $persistentStore.write(JSON.stringify(ids), IAP_KEY);
      iap = ids; changed = true;
      console.log("XBOX-FAMILY: ②内购ID已记录 " + JSON.stringify(ids));
      notify("②【内购】已记录", ids.productId + (ids._name ? " · " + ids._name : ""),
        "avail:" + ids.availabilityId + " sku:" + ids.skuId);
    }
    if (game && iap) break;
  }

  // 每次都日志，便于在"最近请求"里确认脚本是否命中(无论是否首采)
  console.log("XBOX-FAMILY: loadCart 命中, items=" + items.length + " game=" + (game && game.productId) + " iap=" + (iap && iap.productId));

  $done({});
})();
