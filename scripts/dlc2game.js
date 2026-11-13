/**
 * ============================================================
 * dlc2game.js  —— 内购(Consumable) 伪装成游戏(Game)
 * ------------------------------------------------------------
 * 背景: 微软家庭组原生只允许"赠送 Game 类型商品"。内购类
 *       (Consumable / UnmanagedConsumable，如金币/点券/游戏内货币)
 *       没有家庭组赠送入口。本脚本在【返回客户端的商品数据】里
 *       把内购商品伪装成 Game，使"赠送 / 家庭组"入口出现。
 *
 * 触发: http-response, requires-body=1
 * 兼容性:
 *   - 兼容 "type"/"kind" 字段任意顺序与空白
 *   - 兼容 type: addOn / application / unknown ... -> games
 *   - 兼容 kind: Consumable / UnmanagedConsumable        -> Game
 *   - 支持白名单，只伪装指定 productId（留空=全部伪装）
 *
 * 配置: ONLY_PRODUCT_IDS 填你要伪装的内购 productId；空数组=全部。
 * ============================================================
 */

var ONLY_PRODUCT_IDS = [];     // 例: ["9MXQ0XV0R2KM"]；[] = 全部伪装
var TARGET_TYPE = "games";
var TARGET_KIND = "Game";

function isConsumableKind(k) {
  return typeof k === "string" && /^(Unmanaged)?Consumable$/i.test(k);
}

function idHit(obj) {
  if (!ONLY_PRODUCT_IDS || ONLY_PRODUCT_IDS.length === 0) return true;
  var cands = [obj.productId, obj.ProductId, obj.id, obj.Id, obj.skuId, obj.SkuId, obj.fsid, obj.Fsid];
  for (var i = 0; i < cands.length; i++) {
    var v = cands[i];
    if (!v) continue;
    v = String(v);
    if (ONLY_PRODUCT_IDS.indexOf(v) !== -1) return true;
    var u = v.indexOf("_");
    if (u > 0 && ONLY_PRODUCT_IDS.indexOf(v.slice(0, u)) !== -1) return true;
  }
  return false;
}

function walk(node, cb) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i], cb); return; }
  cb(node);
  for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], cb);
}

(function () {
  var body = (typeof $response !== "undefined" && $response && $response.body) ? $response.body : null;
  if (!body) { $done({}); return; }

  var obj = null;
  try { obj = JSON.parse(body); } catch (e) { obj = null; }

  if (obj && typeof obj === "object") {
    var changed = 0;
    walk(obj, function (o) {
      if (isConsumableKind(o.kind)) {
        if (!idHit(o)) return;
        o.kind = TARGET_KIND;
        if (typeof o.type === "string") o.type = TARGET_TYPE;
        changed++;
      }
    });
    try {
      $done({ body: changed > 0 ? JSON.stringify(obj) : body });
    } catch (e) {
      $done({ body: body });
    }
    return;
  }

  // 非 JSON 回退：字段级正则（先 kind 后 type，兼容任意空白）
  var out = body
    .replace(/("kind"\s*:\s*")(?:Unmanaged)?Consumable(")/gi, '$1' + TARGET_KIND + '$2')
    .replace(/("type"\s*:\s*")(?:addOn|application|unknown)(")/gi, '$1' + TARGET_TYPE + '$2');
  $done({ body: out });
})();
