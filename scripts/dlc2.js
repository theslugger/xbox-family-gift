/**
 * dlc2.js —— 伪造家庭组"家长审批"弹窗数据 (pendingRequests)
 * 触发: http-response, requires-body=1
 *   pattern: ^https://.+\.(microsoft|dynamics)\.com/.+pendingRequests.*
 *           （或直接挂到家庭组状态接口，见 sgmodule/conf 注释）
 *
 * 作用: 家庭组审批接口返回 obj.pendingRequests[]，每个 request 含
 *       id(fsid, 形如 PRODUCTID_SKU) / puid / extendedMessage{amount,cid,skuId,...}。
 *       本脚本为其补全 popupStoreUrl / approvalUrl，并把展示文案写成"购买 game"，
 *       让内购项在审批界面表现为一个 Game 购买。
 *
 * 配置:
 *   MARKET / LOCALE  —— 与你的低价区一致(默认 NG)
 *   DEFAULT_SKUID    —— 缺失时补的 skuId(默认 0010，需按真实值改)
 *   FRIENDLY_LABEL   —— 审批弹窗展示的"游戏名"占位
 */
var MARKET = "NG";
var LOCALE = "en-NG";
var DEFAULT_SKUID = "0010";
var FRIENDLY_LABEL = "game";

(function () {
  var body = (typeof $response !== "undefined" && $response && $response.body) ? $response.body : null;
  if (!body) { $done({}); return; }

  var obj = null;
  try { obj = JSON.parse(body); } catch (e) { $done({}); return; }
  if (!obj || !Array.isArray(obj.pendingRequests)) { $done({ body: body }); return; }

  obj.pendingRequests.forEach(function (req) {
    var ext = req.extendedMessage || (req.extendedMessage = {});
    var fsid = req.id || "";
    var cid = ext.cid || req.puid || "";
    var appID = fsid.indexOf("_") > 0 ? fsid.slice(0, fsid.indexOf("_")) : fsid;
    var ask = '{"fsid":"' + fsid + '","cid":"' + cid + '","src":"site"}';

    ext.popupStoreUrl = "https://www.microsoft.com/store/buyboxlitev2?clientType=storewebsdk&market=" +
      MARKET + "&deviceFamily=mobile&locale=" + LOCALE +
      "&noCanonical=true&layout=modal&currentTheme=light&brand=GamingApp&clientVersion=0.5.4&ask=" + ask;

    ext.approvalUrl = "https://www.microsoft.com/" + LOCALE + "/store/apps/" + appID +
      "?ask=" + ask + "&origin=familyapp";

    if (!ext.skuId) ext.skuId = DEFAULT_SKUID;

    if (ext.amount) {
      req.message = "是否可以购买此 " + FRIENDLY_LABEL + " (支付 <b>$ " + ext.amount + ",00</b>)?";
    }
  });

  $done({ body: JSON.stringify(obj) });
})();
