/**
 * name.js —— 把目标商品(内购)的展示名/图标/价格伪装成某个游戏
 * 触发: http-response, requires-body=1
 *   pattern: ^https://displaycatalog\.mp\.microsoft\.com/.+
 * 配置: 改成你实际想伪装成的游戏名称/图标/显示价格(仅供展示，不影响真实扣款)。
 */
var FAKE_TITLE = "Overwatch 2 - 100 Coins";
var FAKE_IMAGE = "//store-images.s-microsoft.com/image/apps.53647.67853844255942228.41453783-f2e6-44d2-9beb-e2557b254e8a.d861ebc3-a645-4a02-86eb-1b720c3db023?w=200&h=200&q=60";
var FAKE_PRICE = "$ 9.99";       // 仅展示用
var APPLY_WHEN_TITLE_EMPTY_ONLY = false; // true=仅当原无标题时改，避免误伤

(function () {
  var body = (typeof $response !== "undefined" && $response && $response.body) ? $response.body : null;
  if (!body) { $done({}); return; }

  var obj = null;
  try { obj = JSON.parse(body); } catch (e) { $done({}); return; }
  if (!obj || typeof obj !== "object") { $done({ body: body }); return; }

  var changed = false;
  if (obj.title === undefined || !APPLY_WHEN_TITLE_EMPTY_ONLY) { obj.title = FAKE_TITLE; changed = true; }
  if (obj.imageUri !== undefined || true) { obj.imageUri = FAKE_IMAGE; changed = true; }
  if (obj.price !== undefined) { obj.price = FAKE_PRICE; }

  $done({ body: changed ? JSON.stringify(obj) : body });
})();
