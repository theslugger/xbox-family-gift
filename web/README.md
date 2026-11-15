# Xbox 家庭组内购送礼 —— 网页版（无需 Surge / Shadowrocket）

纯浏览器油猴脚本，全平台通用（Windows / macOS / Linux / Android / iOS Safari）。
原理：直接在页面 JS 层劫持 `fetch` / `XMLHttpRequest`，改写请求体，**不需要根证书、不需要中间人代理**。

## 安装脚本管理器

| 平台 | 安装 |
|---|---|
| Chrome / Edge / Opera | [Tampermonkey](https://www.tampermonkey.net/) |
| Firefox | [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) |
| Safari (macOS/iOS) | App Store 搜 **Userscripts**（免费，需在设置里开启扩展） |
| Android | Kiwi Browser / Firefox 装 Tampermonkey |

## 安装本脚本

两种方式：

**方式 A（一键）**：装好 Tampermonkey 后，直接打开
```
https://raw.githubusercontent.com/theslugger/xbox-family-gift/main/web/xbox-family-gift.user.js
```
Tampermonkey 会弹出安装页，点「安装」。

**方式 B（本地）**：Tampermonkey → 添加新脚本 → 粘贴 `xbox-family-gift.user.js` 全文 → 保存。

## 使用流程

前提：子号已开启「购买需家长审批」，家长号与子号在同一 Microsoft 家庭组。

1. **子号浏览器**打开 Xbox 网页版，进目标**游戏**页 → 点「加入购物车」
   → 右下角弹出「①【游戏】已记录 productId aval:xxx」
2. 再进**内购（金币）**页 → 加入购物车
   → 弹出「②【内购】已记录 … **avail:B21NVMHMJ32K**」（重点核对 avail）
3. 子号对**游戏**点购买 → 发起家庭组审批
4. **主号浏览器**打开 family safety 审批页 → 页面仍显示**游戏** → 点「批准」
   → 弹出「✅ 已批准」相关提示
5. 付款阶段：
   - `purchase.md.mp.microsoft.com/.../users/me/orders` → 自动换成内购 → 弹「✅ 订单已换内购」
   - `www.microsoft.com/.../buynowui/buynow`（safety 确认页）→ 自动换成内购 → 弹「✅ safety购买页已换内购」

## 菜单命令（Tampermonkey 图标 → 本脚本）

- **查看已采集 ID**：显示当前记录的游戏/内购三件套
- **清空已采集 ID**：重置，重新加购

## 实现要点（对应原来 Surge 版）

| Surge 版 | 网页版 |
|---|---|
| `$persistentStore` | `GM_setValue / GM_getValue` |
| `$notification.post` | `GM_notification` + 页面右下角 toast |
| `http-request` script 拦截 | 劫持 `window.fetch` + `XMLHttpRequest.prototype.send` |
| `family/api/product` 不碰 | 同样不碰（审批页保持显示游戏） |
| `swapOne` 三件套一致替换 | 完全一致（productId + availabilityId + skuId） |
| 内购 avail 缺失则不换（防 404） | 完全一致 |

## 注意事项

1. **必须在网页版操作**。Xbox 主机/手机 App 有证书固定，本脚本不生效（也不打算绕过）。
2. **子号和主号各自的浏览器都要装脚本**（ID 存各自浏览器里；实际替换只发生在主号付款那台）。
   如果主号和子号在同一浏览器/同一账号切着用，更简单——脚本会按 productId 自动区分。
3. 浏览器隐私模式 / 清缓存会丢 `GM_setValue` 记录，需要重新加购。
4. 微软改接口字段时需更新脚本，位置见 `maybeSwap()` 的正则。
5. **合规提示**：篡改商店购买请求违反微软服务条款，可能导致账号/家庭组受限。仅在你自己有权处置的账号上使用。
