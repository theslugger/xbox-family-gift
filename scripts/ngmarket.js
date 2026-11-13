/**
 * ngmarket.js —— 把商店请求市场改为低价区(默认 NG 尼日利亚)
 * 触发: http-request, requires-body=1
 *   pattern: ^https://cart\.production\.store-web\.dynamics\.com/v\d+\.\d+/cart/loadCart
 * 配置: TARGET_MARKET / TARGET_LOCALE 按需修改。
 */
var TARGET_MARKET = "NG";
var TARGET_LOCALE = "en-NG";

(function () {
  if (typeof $request === "undefined" || !$request) { $done({}); return; }
  if ((($request.method || "GET").toUpperCase()) === "OPTIONS") { $done({}); return; }

  var headers = $request.headers || {};
  var body = $request.body, obj = null;
  if (body && body.trim().charAt(0) === "{") {
    try { obj = JSON.parse(body); } catch (e) { obj = null; }
  }

  if (obj) {
    if (obj.market) obj.market = TARGET_MARKET;
    if (obj.locale) obj.locale = TARGET_LOCALE;
    if (obj.friendlyName) {
      var isCart = ($request.url || "").indexOf("appId=storeCart") !== -1;
      obj.friendlyName = isCart ? "cart-save-for-later-" + TARGET_MARKET : "cart-" + TARGET_MARKET;
    }
  }

  // 头大小写无关地改 X-MS-Market
  var newHeaders = {};
  for (var k in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, k)) {
      newHeaders[k] = (k.toLowerCase() === "x-ms-market") ? TARGET_MARKET : headers[k];
    }
  }

  $done({ headers: newHeaders, body: obj ? JSON.stringify(obj) : body });
})();
