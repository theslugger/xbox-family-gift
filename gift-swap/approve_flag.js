/**
 * ============================================================
 * approve_flag.js —— 主号点了"批准购买"后打标记 approved=1
 * ------------------------------------------------------------
 * 作用: 拦截 account.microsoft.com/family/api/buy/requests/approve
 *       （主号在 family safety 点"批准"），在本地存储写入 approvedTime。
 *       供 swap_payment.js 判断"是否已到最终付款阶段"，
 *       避免子号发起购买时就替换（太早）。
 * 触发: http-request, requires-body=1
 *   pattern: ^https://account\.microsoft\.com/family/api/buy/requests/approve
 * ============================================================
 */

function notify(title, subtitle, body) {
  // 仅 Surge: $notification.post
  try { $notification.post(title, subtitle || "", body || ""); } catch (e) {}
}

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "").toUpperCase()) !== "POST") { $done({}); return; }
  var url = $request.url || "";
  if (url.indexOf("/family/api/buy/requests/approve") === -1) { $done({}); return; }

  $persistentStore.write(String(Date.now()), "approvedTime");
  notify("✅ 已批准", "进入最终付款阶段", "此后 orders 将被替换为内购");
  $done({});
})();
