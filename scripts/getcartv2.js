/**
 * getcartv2.js —— 采集购物车 cartId 与 lineItemId 并持久化
 * 触发: http-response, requires-body=1
 *   pattern: ^https://cart\.production\.store-web\.dynamics\.com/v\d+\.\d+/cart/loadCart
 * 作用: 供 getgift.js 在送礼/家庭组请求里替换 cartId 与 lineItemId。
 */
(function () {
  var body = (typeof $response !== "undefined" && $response && $response.body) ? $response.body : null;
  if (!body) { $done({}); return; }

  var obj = null;
  try { obj = JSON.parse(body); } catch (e) { $done({}); return; }

  var cart = obj && obj.cart;
  if (cart && cart.id) {
    $persistentStore.write(cart.id, "cartId");
    var li = cart.lineItems && cart.lineItems.length > 0 ? cart.lineItems[0] : null;
    if (li && li.id) {
      $persistentStore.write(li.id, "lineItemId");
      $notification.post("Cart 采集成功", "cartId: " + cart.id, "lineItemId: " + li.id);
    } else {
      $notification.post("Cart 采集成功", "cartId: " + cart.id, "无 lineItems(尚未加购?)");
    }
  } else {
    $notification.post("Cart 采集失败", "响应中未找到 cart.id", "");
  }
  $done({});
})();
