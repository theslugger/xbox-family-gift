/**
 * ============================================================
 * capture_ids.js —— 采集"游戏"与"内购"商品三件套(productId/skuId/availabilityId)
 * ------------------------------------------------------------
 * 关键修复(v8):
 *   - 之前用"if(!game)/if(!iap)"才记录, 导致本地一旦存了脏数据(旧 availabilityId)
 *     就永远不再更新 -> 付款时换成错的 availabilityId -> 订单 404。
 *   - 现改为: 每次加购 loadCart 命中, 都用【本次请求里的真实 availabilityId】
 *     覆盖存储(同 productId 也更新), 保证三件套永远是最新的真值。
 *   - 每次命中都弹窗(Surge $notification.post), 显示 avail, 便于核对。
 *
 * 识别游戏 vs 内购: 按出现顺序, 第1个不同商品=游戏, 第2个不同商品=内购。
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";

function notify(title, subtitle, body) {
  try { $notification.post(title, subtitle || "", body || ""); } catch (e) {}
}
function loadIds(k) { try { var v = $persistentStore.read(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function sameProduct(a, b) { return a && b && a.productId === b.productId; }
function fullId(a) { return a && a.productId && a.availabilityId && a.skuId; }

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

  for (var i = 0; i < items.length; i++) {
    var ids = items[i];

    // 1) 与已存"游戏"同 productId -> 用本次真实 availabilityId 覆盖(修脏数据), 弹①
    if (game && sameProduct(game, ids)) {
      if (!fullId(game) || game.availabilityId !== ids.availabilityId || game.skuId !== ids.skuId) {
        $persistentStore.write(JSON.stringify(ids), GAME_KEY);
        game = ids;
        notify("①【游戏】ID已更新", ids.productId, "avail:" + ids.availabilityId + " sku:" + ids.skuId);
      } else {
        notify("①【游戏】命中", ids.productId, "avail:" + ids.availabilityId);
      }
      continue;
    }
    // 2) 与已存"内购"同 productId -> 覆盖, 弹②
    if (iap && sameProduct(iap, ids)) {
      if (!fullId(iap) || iap.availabilityId !== ids.availabilityId || iap.skuId !== ids.skuId) {
        $persistentStore.write(JSON.stringify(ids), IAP_KEY);
        iap = ids;
        notify("②【内购】ID已更新", ids.productId, "avail:" + ids.availabilityId + " sku:" + ids.skuId);
      } else {
        notify("②【内购】命中", ids.productId, "avail:" + ids.availabilityId);
      }
      continue;
    }

    // 3) 全新商品
    if (!game) {
      $persistentStore.write(JSON.stringify(ids), GAME_KEY);
      game = ids;
      notify("①【游戏】已记录", ids.productId + (ids._name ? " · " + ids._name : ""), "avail:" + ids.availabilityId + " sku:" + ids.skuId);
    } else if (!iap) {
      $persistentStore.write(JSON.stringify(ids), IAP_KEY);
      iap = ids;
      notify("②【内购】已记录", ids.productId + (ids._name ? " · " + ids._name : ""), "avail:" + ids.availabilityId + " sku:" + ids.skuId);
    }
  }

  console.log("XBOX-FAMILY: loadCart命中 items=" + items.length +
    " game=" + JSON.stringify(game) + " iap=" + JSON.stringify(iap));

  $done({});
})();
