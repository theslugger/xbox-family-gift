/**
 * getgift.js —— 在送礼/批量更新/家庭组审批请求里替换 cartId 与 lineItemId
 * 触发: http-request, requires-body=1
 *   pattern: ^https://cart\.production\.store-web\.dynamics\.com/v\d+\.\d+/cart/
 *            （loadCart 之外的 cart 写操作：bulkUpdate / addGift / RequestParentalApproval 等）
 * 作用: 把你已采集的内购购物车(cartId/lineItemId) 顶替进送礼请求，
 *       让"送出/审批购买"的是那个内购购物车项。
 */
(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "GET").toUpperCase()) === "OPTIONS") { $done({}); return; }

  var cartId = $persistentStore.read("cartId");
  var lineItemId = $persistentStore.read("lineItemId");
  var url = $request.url || "";
  var body = $request.body;

  if (!cartId || !lineItemId) {
    $notification.post("数据缺失", "未采集到 cartId/lineItemId", "请先打开购物车");
    $done({});
    return;
  }

  // 替换 URL 中 cartId 查询参数
  if (/cartId=[^&]+/.test(url)) url = url.replace(/cartId=[^&]+/, "cartId=" + cartId);

  if (!body) { $done({ url: url }); return; }

  var obj = null;
  try { obj = JSON.parse(body); } catch (e) { obj = null; }

  if (obj && typeof obj === "object") {
    // 顶层 cartId
    if (obj.cartId) obj.cartId = cartId;
    // items[].id / lineItemId 替换为已存 lineItemId
    if (Array.isArray(obj.items) && obj.items.length > 0) {
      for (var i = 0; i < obj.items.length; i++) {
        if (obj.items[i] && obj.items[i].id !== undefined) obj.items[i].id = lineItemId;
      }
    }
    // 有些接口用 lineItemId 字段
    if (obj.lineItemId !== undefined) obj.lineItemId = lineItemId;

    $done({ url: url, body: JSON.stringify(obj) });
  } else {
    // 非 JSON：仅替换 URL 中 cartId，body 原样
    $done({ url: url });
  }
})();
