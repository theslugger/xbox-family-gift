/**
 * ============================================================
 * swap_payment.js —— 只在【主号 family safety 确认购买页】的 buynow 替换
 * ------------------------------------------------------------
 * 精确特征(来自真实 HAR 2026-11):
 *   主号在 family safety 批准(approve)后进入"确认购买"页，
 *   此时发出的 buynow 请求带有:
 *     callerApplicationId = AMCFamilySafetyApp
 *     scenario            = parentApproval
 *     Origin              = https://account.microsoft.com
 *     products            = [{"productId","skuId","availabilityId"}]  <- 游戏
 *
 *   子号发起购买/普通购买页的 buynow 是 callerApplicationId=XboxCom，
 *   不会被本脚本替换（避免"子号发起就替换"）。
 *
 * 替换动作: 把该 buynow 的 products= 里的 productId/skuId/availabilityId
 *          换成内购(idsIAP)。仅此一处，其它请求一律放行。
 *
 * 数据: 本地存储 idsGame / idsIAP（capture_ids.js 采集）
 * ============================================================
 */

var GAME_KEY = "idsGame";
var IAP_KEY = "idsIAP";
function load(k) { try { return JSON.parse($persistentStore.read(k)); } catch (e) { return null; } }
function q(s) { return encodeURIComponent(s); }
function unq(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function parseForm(text) {
  var d = {};
  var parts = text.split("&");
  for (var i = 0; i < parts.length; i++) {
    var idx = parts[i].indexOf("=");
    if (idx < 0) continue;
    d[unq(parts[i].slice(0, idx))] = parts[i].slice(idx + 1); // 保留原编码的 value
  }
  return d;
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) === "OPTIONS") { $done({}); return; }
  var url = $request.url || "";

  // 只处理 buynow 确认购买页
  if (!/www\.microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url)) { $done({}); return; }

  var body = $request.body;
  if (!body) { $done({}); return; }

  var d = parseForm(body);

  // ===== 关键判定：必须是主号 family safety 的购买页 =====
  var caller = d["callerApplicationId"] ? unq(d["callerApplicationId"]) : "";
  var scenario = d["scenario"] ? unq(d["scenario"]) : "";
  if (caller !== "AMCFamilySafetyApp" && scenario !== "parentApproval") {
    // 子号/普通购买页(XboxCom) -> 不替换
    $done({}); return;
  }

  // 读取 ids
  var game = load(GAME_KEY), iap = load(IAP_KEY);
  if (!game || !iap) {
    $notification.post("未替换", "缺少 idsGame/idsIAP", "请先加购: 游戏→内购");
    $done({}); return;
  }

  // products= 解析
  if (d["products"] === undefined) { $done({}); return; }
  var arr;
  try { arr = JSON.parse(unq(d["products"])); } catch (e) { $done({}); return; }
  if (!Array.isArray(arr)) { $done({}); return; }

  var changed = 0;
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i] || {};
    if (it.productId === game.productId) { it.productId = iap.productId; changed++; }
    if (game.skuId && it.skuId === game.skuId) { it.skuId = iap.skuId; changed++; }
    if (game.availabilityId && iap.availabilityId && it.availabilityId === game.availabilityId) {
      it.availabilityId = iap.availabilityId; changed++;
    }
  }
  if (changed === 0) { $done({}); return; }

  // 重建 body（只替换 products 字段，其它原样）
  var newParts = [];
  var parts = body.split("&");
  for (var j = 0; j < parts.length; j++) {
    var idx2 = parts[j].indexOf("=");
    if (idx2 < 0) { newParts.push(parts[j]); continue; }
    var k = unq(parts[j].slice(0, idx2));
    if (k === "products") {
      newParts.push(parts[j].slice(0, idx2) + "=" + q(JSON.stringify(arr)));
    } else {
      newParts.push(parts[j]);
    }
  }

  $notification.post("✅ safety购买页已替换为内购", iap.productId + " · sku " + iap.skuId, "场景: parentApproval");
  $done({ body: newParts.join("&") });
})();
